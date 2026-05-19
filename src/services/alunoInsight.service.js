import Anthropic from '@anthropic-ai/sdk';

import { env } from '../lib/env.js';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../middleware/errorHandler.js';
import { resolveAlunoAccess } from '../lib/access.js';
import { insightResultSchema, TTL_DAYS } from '../schemas/alunoInsight.schemas.js';
import { validarTextoCom } from '../lib/insightVeto.js';

import { buildAlunoInsightSnapshot } from './alunoInsightData.service.js';

// PR #32 — Aluno Weekly Check-in (Sprint 12 / Aluno Intelligence).
//
// Pipeline:
//   1. ACL via resolveAlunoAccess (ALUNO próprio OU PROFESSOR vinculado).
//   2. Cache hit válido? serve.
//   3. Snapshot agregador (4 semanas determinístico).
//   4. temDadosSuficientes=false → atalho estático (sem IA).
//   5. LLM call com system cached + tool_use forçado.
//   6. Zod estrito do output.
//   7. Filtro veto lexical. Veto bate? regenera 1x com nota no prompt.
//   8. 2ª veto? fallback estático em código (último escudo).
//   9. Upsert no cache + audit em meta.

let _client = null;
function getClient() {
  if (_client) return _client;
  if (!env.ANTHROPIC_API_KEY) {
    throw new HttpError(503, 'Insight semanal indisponível (IA off)');
  }
  _client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  return _client;
}

export function __setClientForTests(c) { _client = c; }
export function __resetClientForTests() { _client = null; }

// ─── System prompt — coleira curta ──────────────────────────────────

const SYSTEM_PROMPT = `Você é um assistente que NARRA RETROATIVAMENTE a semana de treino do aluno em português do Brasil, em tom de coach experiente e encorajador.

OBJETIVO ÚNICO: olhar pro retrovisor. Interpretar o que JÁ ACONTECEU.

REGRAS NEGATIVAS (não negociáveis):
1. NUNCA recomende mudança de carga, intensidade, volume ou frequência.
2. NUNCA contradiga ou questione a prescrição do treinador. Se o volume parece pesado, NÃO diga "considere reduzir" — diga "esta semana exigiu bastante, você entregou".
3. NUNCA faça previsões de paces, RPs ou performance futura. ZERO "você vai bater seu RP em X semanas".
4. NUNCA dê conselhos médicos, de sono, de hidratação, de suplementação.
5. NUNCA mencione lesão, dor, fadiga muscular ou recuperação — território exclusivo do coach/médico.
6. NUNCA invente números, datas ou modalidades que não estão no JSON.

O QUE FAZER:
1. summary (40-400 chars, max 3 frases): destaque consistência semanal + volume entregue. Mencione NÚMEROS do JSON. Ex: "Você fechou 4 semanas seguidas com 14 treinos concluídos. RPE médio caiu de 8 para 7.2, sinal positivo de adaptação."
2. destaques (até 3, cada 10-100 chars): marcos do JSON, sem amplificação. Ex: "Primeiro RP de musculação desbloqueado".
3. Tom: factual, encorajador SEM ser pueril. Nada de "você é demais!" ou exclamações repetidas.

Saída APENAS via tool submit_insight. Sem texto fora da tool.`;

const TOOL_DEF = {
  name: 'submit_insight',
  description: 'Submete o insight semanal narrativo do aluno.',
  input_schema: {
    type: 'object',
    properties: {
      summary: { type: 'string', minLength: 40, maxLength: 400 },
      destaques: {
        type: 'array',
        maxItems: 3,
        items: { type: 'string', minLength: 10, maxLength: 100 },
      },
    },
    required: ['summary', 'destaques'],
    additionalProperties: false,
  },
};

// ─── Cache helpers ──────────────────────────────────────────────────

function isExpired(insight) {
  if (!insight?.expiresAt) return true;
  return insight.expiresAt.getTime() < Date.now();
}

function expiresAtFromNow() {
  return new Date(Date.now() + TTL_DAYS * 24 * 60 * 60 * 1000);
}

// ─── Service principal ──────────────────────────────────────────────

/**
 * Retorna insight semanal pro aluno. Cache-aware.
 *
 * @param {object} args
 * @param {{userId: string, role: string}} args.user
 * @param {string} [args.alunoId]
 * @param {boolean} [args.force] — bypass cache (refresh manual, rate-limited na rota).
 *
 * @returns {Promise<{
 *   result: {summary, destaques, origem},
 *   generatedAt: Date, expiresAt: Date,
 *   fresh: boolean, stale: boolean, empty: boolean,
 * }>}
 */
export async function getWeeklyCheckin({ user, alunoId, force = false }) {
  const aluno = await resolveAlunoAccess({ user, alunoId });

  // Snapshot determinístico — fonte única de verdade.
  const snapshot = await buildAlunoInsightSnapshot({ alunoId: aluno.id });

  // Atalho 1: sem dados → estático sem IA.
  if (!snapshot.temDadosSuficientes) {
    return semDadosResponse();
  }

  // Cache hit?
  const existing = await prisma.alunoInsightSemanal.findUnique({
    where: { alunoId: aluno.id },
  });
  if (!force && existing && !isExpired(existing)) {
    return {
      result: existing.result,
      generatedAt: existing.generatedAt,
      expiresAt: existing.expiresAt,
      fresh: true,
      stale: false,
      empty: false,
    };
  }

  // Tenta LLM. Se falhar com cache existente, serve stale.
  let llmResult;
  try {
    llmResult = await tentarLLM({ snapshot, tentativas: 2 });
  } catch (err) {
    if (existing) {
      return {
        result: existing.result,
        generatedAt: existing.generatedAt,
        expiresAt: existing.expiresAt,
        fresh: false,
        stale: true,
        empty: false,
      };
    }
    // Sem cache + LLM down → fallback estático em vez de 5xx.
    // Aluno nunca fica sem resposta.
    const estatico = construirInsightEstatico(snapshot);
    return persistirEDevolver({ alunoId: aluno.id, payload: estatico, llmTentativas: 0, vetoBateu: false });
  }

  return persistirEDevolver({
    alunoId: aluno.id,
    payload: llmResult.payload,
    llmTentativas: llmResult.tentativas,
    vetoBateu: llmResult.vetoBateu,
  });
}

// Tenta o LLM ATÉ N vezes. Em cada tentativa:
//   - chama Anthropic
//   - valida Zod (input_schema da Anthropic já reduz risco, mas guard)
//   - aplica filtro veto
//   - se passou → devolve
//   - se vetou → próxima iteração com nota no prompt explicando o termo
// Se esgotar tentativas, lança HttpError 502 OU retorna fallback estático.
async function tentarLLM({ snapshot, tentativas }) {
  let ultimoVetoBatido = null;

  for (let n = 1; n <= tentativas; n++) {
    const userPayload = JSON.stringify(snapshot, null, 2);
    const promptAdicional = ultimoVetoBatido
      ? `\n\nIMPORTANTE: sua geração anterior continha "${ultimoVetoBatido}", que é PROIBIDO. Refaça evitando recomendações, termos médicos ou previsões.`
      : '';

    const response = await callClient({ userPayload, promptAdicional });
    const tool = response.content?.find((b) => b.type === 'tool_use' && b.name === 'submit_insight');
    if (!tool) {
      // Se não devolveu tool_use, considera falha — vai pro fallback no caller.
      throw new HttpError(502, 'IA não devolveu tool_use esperado');
    }

    const parsed = insightResultSchema.safeParse(tool.input);
    if (!parsed.success) {
      // Falha estrutural — não tenta repair sofisticado aqui (snapshot é
      // simples; se LLM erra estrutura nesse contexto, segue pro fallback).
      throw new HttpError(502, 'IA devolveu insight fora do schema');
    }

    const veto = validarTextoCom(parsed.data.summary, ...parsed.data.destaques);
    if (veto.ok) {
      return {
        payload: { ...parsed.data, origem: 'llm' },
        tentativas: n,
        vetoBateu: false,
      };
    }
    // Veto bateu — guarda termo + loga + tenta de novo (se houver tentativa).
    ultimoVetoBatido = veto.vetoBatido;
    console.warn(JSON.stringify({
      level: 'warn',
      msg: 'aluno-insight-veto-batido',
      tentativa: n,
      vetoBatido: veto.vetoBatido,
      categoria: veto.categoria,
    }));
  }

  // Esgotou tentativas com veto → fallback estático em código.
  return {
    payload: { ...construirInsightEstatico(snapshot), origem: 'fallback-veto' },
    tentativas,
    vetoBateu: true,
  };
}

async function callClient({ userPayload, promptAdicional }) {
  const client = getClient();
  try {
    return await client.messages.create({
      model: env.ANTHROPIC_MODEL,
      max_tokens: 800,
      system: [
        // Cache breakpoint: system + tool são estáveis entre todos os
        // alunos. Custo amortizado.
        { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
      ],
      tools: [TOOL_DEF],
      tool_choice: { type: 'tool', name: 'submit_insight' },
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Fechamento do aluno (4 semanas):\n${userPayload}\n\nNarre via submit_insight.${promptAdicional}`,
            },
          ],
        },
      ],
    });
  } catch (err) {
    const status = err?.status;
    if (status === 401 || status === 403) throw new HttpError(500, 'Credenciais IA inválidas');
    if (status === 429) throw new HttpError(429, 'Limite de IA atingido — tente em alguns minutos');
    throw new HttpError(504, `IA indisponível: ${err?.message || 'unknown'}`);
  }
}

// ─── Fallback estático — último escudo ──────────────────────────────
//
// Construído puramente em código a partir do snapshot. Zero IA, zero
// risco. Texto sempre dentro das regras (não usa termos do veto).

function construirInsightEstatico(snapshot) {
  const { consistencia, volume, qualidade, marcos } = snapshot;
  const partes = [];

  if (consistencia.semanasValidasUltimas4 > 0) {
    partes.push(
      `Você fechou ${consistencia.semanasValidasUltimas4} de 4 semanas válidas com ${volume.totalTreinosConcluidos} treino${volume.totalTreinosConcluidos !== 1 ? 's' : ''} concluído${volume.totalTreinosConcluidos !== 1 ? 's' : ''}.`,
    );
  } else {
    partes.push(`Você registrou ${volume.totalTreinosConcluidos} treino${volume.totalTreinosConcluidos !== 1 ? 's' : ''} nas últimas 4 semanas.`);
  }

  if (consistencia.streakAtual >= 2) {
    partes.push(`Streak atual: ${consistencia.streakAtual} semanas.`);
  }

  if (qualidade.rpeMedioMusculacao != null) {
    partes.push(`RPE médio de musculação: ${qualidade.rpeMedioMusculacao}.`);
  }

  // Garante summary com pelo menos 40 chars (limite Zod).
  let summary = partes.join(' ');
  if (summary.length < 40) {
    summary = `${summary} Continue registrando seus treinos para acompanhar a evolução.`;
  }
  summary = summary.slice(0, 400);

  const destaques = [];
  if (marcos.rpsNovos > 0) {
    destaques.push(`${marcos.rpsNovos} novo${marcos.rpsNovos !== 1 ? 's' : ''} recorde${marcos.rpsNovos !== 1 ? 's' : ''} pessoal${marcos.rpsNovos !== 1 ? 'is' : ''} no período.`);
  }
  if (marcos.conquistasDesbloqueadas.length > 0) {
    destaques.push(`${marcos.conquistasDesbloqueadas.length} conquista${marcos.conquistasDesbloqueadas.length !== 1 ? 's' : ''} desbloqueada${marcos.conquistasDesbloqueadas.length !== 1 ? 's' : ''}.`);
  }
  if (volume.diasComAtividade >= 12) {
    destaques.push(`Atividade em ${volume.diasComAtividade} dias diferentes.`);
  }

  return { summary, destaques: destaques.slice(0, 3), origem: 'fallback-estatico' };
}

function semDadosResponse() {
  return {
    result: {
      summary: 'Semana sem treinos registrados. Comece esta para abrir o ciclo de fechamento.',
      destaques: [],
      origem: 'sem-dados',
    },
    generatedAt: new Date(),
    expiresAt: expiresAtFromNow(),
    fresh: true,
    stale: false,
    empty: true,
  };
}

async function persistirEDevolver({ alunoId, payload, llmTentativas, vetoBateu }) {
  const saved = await prisma.alunoInsightSemanal.upsert({
    where: { alunoId },
    create: {
      alunoId,
      result: payload,
      meta: {
        modelo: env.ANTHROPIC_MODEL,
        llmTentativas,
        vetoBateu,
        geradoEm: new Date().toISOString(),
      },
      expiresAt: expiresAtFromNow(),
    },
    update: {
      result: payload,
      meta: {
        modelo: env.ANTHROPIC_MODEL,
        llmTentativas,
        vetoBateu,
        geradoEm: new Date().toISOString(),
      },
      generatedAt: new Date(),
      expiresAt: expiresAtFromNow(),
    },
  });
  return {
    result: saved.result,
    generatedAt: saved.generatedAt,
    expiresAt: saved.expiresAt,
    fresh: true,
    stale: false,
    empty: false,
  };
}

export const __internal = { construirInsightEstatico };
