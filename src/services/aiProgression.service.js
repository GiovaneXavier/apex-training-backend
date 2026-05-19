import Anthropic from '@anthropic-ai/sdk';

import { env } from '../lib/env.js';
import { HttpError } from '../middleware/errorHandler.js';
import { suggestedProgressionSchema } from '../schemas/aiProgression.schemas.js';

import {
  buildExercicioSnapshot,
  checkProfessorOwnership,
  getNomeAlunoEncurtado,
} from './aiProgressionData.service.js';

// PR #29 — AI Progression Suggestion (motor de progressão por exercício).
//
// CONTRATO: 1 exercício, 1 aluno → 1 sugestão. Não persiste. Não toca
// no treino sendo construído pelo coach. Stateless do POV do server.
//
// Cadeia de defesa antes da LLM:
//   1. Feature flag ANTHROPIC (503 se off).
//   2. Ownership: VinculoProfessor existe? Se não → 403 SEM tocar LLM.
//   3. Snapshot histórico via GIN seek (rápido).
//   4. LLM call com tool_use estruturado.
//   5. Zod estrito + repair tolerante (mesmo padrão do #28).

let _client = null;
function getClient() {
  if (_client) return _client;
  if (!env.ANTHROPIC_API_KEY) {
    throw new HttpError(503, 'AI Progression indisponível (IA off)');
  }
  _client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  return _client;
}

export function __setClientForTests(c) { _client = c; }
export function __resetClientForTests() { _client = null; }

// ─── Prompts ─────────────────────────────────────────────────────────

const SYSTEM_PROMPT_MUSCULACAO = `Você é um assistente de força/condicionamento que sugere a PRÓXIMA progressão de um exercício de MUSCULAÇÃO baseado no histórico recente do aluno.

Princípios (não negociáveis):
1. Sobrecarga progressiva é o default — aumente carga OU volume vs a última sessão, NUNCA os dois ao mesmo tempo.
2. Se RPE médio do último treino ≥ 9 OU readiness ≤ 4: DELOAD (-10% a -20% intensidade). tipoProgressao = "deload".
3. Se RPE médio ≤ 6 + todas as reps atingidas: aumentar intensidade (+2.5kg upper-body, +5kg lower-body). tipoProgressao = "intensidade".
4. Se houveFalhaDeReps = true (drop de reps entre sets > 25%): MANTER carga, focar em completar reps. tipoProgressao = "manutencao".
5. RPE 7-8 estável: subir volume (+1 set OU +1-2 reps por set), carga igual. tipoProgressao = "volume".
6. SEM histórico: sugestão conservadora baseada apenas no nome do exercício. cargaEstimadaKg pode ser null. tipoProgressao = "manutencao". Justificativa: "Sem histórico — começamos leve para calibrar".

Justificativa OBRIGATÓRIA: 1 frase curta citando NÚMEROS específicos do histórico recebido. Nunca genérico. Ex: "RPE médio 8.5 na última sessão com 3x8 a 80kg → mantém carga e adiciona 1 set para acumular volume".

Saída via tool "suggest_progression". Não invente histórico. Não recomende exercícios alternativos. Não escreva mais do que o necessário.`;

const SYSTEM_PROMPT_CALISTENIA = `Você é um assistente de força/condicionamento que sugere a PRÓXIMA progressão de um exercício CALISTÊNICO (sem carga externa) baseado no histórico recente do aluno.

Em calistenia NÃO HÁ kg pra subir — a sobrecarga progressiva acontece manipulando a string "reps":
- Aumentar faixa: "8-10" → "10-12".
- Trocar pra AMRAP (até a falha) quando o aluno já domina faixa alta.
- Adicionar tempo isométrico: "30s" → "45s".
- Aumentar sets em vez de reps quando reps já estão altas (ex: ≥15).
- Em fadiga (RPE médio ≥ 9 OU houveFalhaDeReps): MANTER faixa, descontar 1 set se necessário.

Regras estritas:
- cargaEstimadaKg DEVE ser null em calistenia.
- "reps" carrega a progressão: string curta, ≤20 chars. Ex: "8-10", "10-12", "AMRAP", "30s", "Máx".
- Sem histórico: sugestão conservadora. tipoProgressao = "manutencao". Justificativa: "Sem histórico — começamos com faixa baixa para calibrar".
- Justificativa OBRIGATÓRIA: 1 frase citando NÚMEROS do histórico. Ex: "Última sessão 3x12 com RPE 6.5 → eleva faixa para 12-15 mantendo 3 sets".

Saída via tool "suggest_progression". rpeAlvo pode ser null em calistenia. Nunca invente.`;

const TOOL_DEF = {
  name: 'suggest_progression',
  description: 'Submete a sugestão de progressão para o próximo treino.',
  input_schema: {
    type: 'object',
    properties: {
      sets: { type: 'integer', minimum: 1, maximum: 10 },
      reps: { type: 'string', maxLength: 20 },
      cargaEstimadaKg: { type: ['number', 'null'], minimum: 0, maximum: 2000 },
      rpeAlvo: { type: ['number', 'null'], minimum: 1, maximum: 10 },
      justificativa: { type: 'string', maxLength: 200 },
      tipoProgressao: {
        type: 'string',
        enum: ['intensidade', 'volume', 'manutencao', 'deload'],
      },
    },
    required: ['sets', 'reps', 'cargaEstimadaKg', 'rpeAlvo', 'justificativa', 'tipoProgressao'],
    additionalProperties: false,
  },
};

// ─── Service principal ──────────────────────────────────────────────

/**
 * Sugere progressão para 1 exercício de 1 aluno.
 *
 * @param {object} args
 * @param {{userId: string, role: string}} args.user
 * @param {string} args.alunoId
 * @param {string} args.exercicioNome
 * @param {'MUSCULACAO'|'CALISTENIA'} args.modalidade
 *
 * @returns {Promise<{sugestao: object, contextoUsado: object}>}
 *   sugestao    — payload pronto pra hidratar inputs do form.
 *   contextoUsado — meta de debug (n execuções, RPE médio, modalidade).
 */
export async function suggestProgression({ user, alunoId, exercicioNome, modalidade }) {
  if (user.role !== 'PROFESSOR') {
    throw new HttpError(403, 'Apenas professores podem usar a sugestão IA');
  }
  if (!env.ANTHROPIC_API_KEY) {
    throw new HttpError(503, 'AI Progression indisponível (IA off)');
  }

  // Ownership pre-check: ANTES do snapshot e ANTES do LLM. Anti billing-drain.
  const ok = await checkProfessorOwnership({ userId: user.userId, alunoId });
  if (!ok) {
    throw new HttpError(403, 'Aluno não vinculado a este professor');
  }

  const [snapshot, alunoNome] = await Promise.all([
    buildExercicioSnapshot({ alunoId, exercicioNome }),
    getNomeAlunoEncurtado(alunoId),
  ]);

  const isCalistenia = modalidade === 'CALISTENIA';
  const systemPrompt = isCalistenia ? SYSTEM_PROMPT_CALISTENIA : SYSTEM_PROMPT_MUSCULACAO;

  const userPayload = {
    aluno: { nome: alunoNome },
    exercicio: exercicioNome,
    modalidade,
    historico: snapshot.execucoes,
    rpeMedioRecente: snapshot.rpeMedioRecente,
    houveFalhaDeReps: snapshot.houveFalhaDeReps,
    diasDesdeUltimaExecucao: snapshot.diasDesdeUltima,
  };

  const llmInput = await callLLM({
    systemPrompt,
    userPayload,
    isCalistenia,
  });

  // Zod estrito → repair tolerante (mesmo padrão do #28).
  let sugestao;
  const parsed = suggestedProgressionSchema.safeParse(llmInput);
  if (parsed.success) {
    sugestao = parsed.data;
  } else {
    const repaired = tryRepair(llmInput, isCalistenia);
    const reParsed = suggestedProgressionSchema.safeParse(repaired);
    if (!reParsed.success) {
      throw new HttpError(502, 'IA devolveu sugestão fora do schema');
    }
    sugestao = reParsed.data;
  }

  // Defesa-em-profundidade: em calistenia, força carga=null mesmo se LLM
  // teimar em mandar valor. O frontend NÃO renderiza campo de kg pra
  // calistenia, então valor inválido viraria lixo silencioso.
  if (isCalistenia && sugestao.cargaEstimadaKg != null) {
    sugestao = { ...sugestao, cargaEstimadaKg: null };
  }

  return {
    sugestao,
    contextoUsado: {
      execucoesConsideradas: snapshot.execucoes.length,
      rpeMedioRecente: snapshot.rpeMedioRecente,
      houveFalhaDeReps: snapshot.houveFalhaDeReps,
      diasDesdeUltima: snapshot.diasDesdeUltima,
      modalidade,
    },
  };
}

async function callLLM({ systemPrompt, userPayload, isCalistenia }) {
  const client = getClient();

  let response;
  try {
    response = await client.messages.create({
      model: env.ANTHROPIC_MODEL,
      max_tokens: 800,
      system: [
        // Cache breakpoint: system prompt é estável por modalidade.
        // Coaches em rajada de cliques no Workout Builder reusam cache.
        { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
      ],
      tools: [TOOL_DEF],
      tool_choice: { type: 'tool', name: 'suggest_progression' },
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Contexto do aluno e histórico:\n\n${JSON.stringify(userPayload, null, 2)}\n\nSugira a próxima progressão chamando suggest_progression.`,
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

  const tool = response.content?.find((b) => b.type === 'tool_use' && b.name === 'suggest_progression');
  if (!tool) throw new HttpError(502, 'IA não devolveu tool_use esperado');
  return tool.input || {};
}

function tryRepair(raw, isCalistenia) {
  if (!raw || typeof raw !== 'object') return raw;
  const out = { ...raw };

  out.sets = clampInt(out.sets, 1, 10, 3);
  out.reps = typeof out.reps === 'string' && out.reps.trim().length > 0
    ? out.reps.slice(0, 20)
    : (isCalistenia ? '10-12' : '8-10');
  out.cargaEstimadaKg = isCalistenia
    ? null
    : (typeof out.cargaEstimadaKg === 'number' && out.cargaEstimadaKg >= 0 && out.cargaEstimadaKg <= 2000
        ? out.cargaEstimadaKg
        : null);
  out.rpeAlvo = typeof out.rpeAlvo === 'number' && out.rpeAlvo >= 1 && out.rpeAlvo <= 10
    ? out.rpeAlvo
    : null;
  out.justificativa = typeof out.justificativa === 'string'
    ? out.justificativa.slice(0, 200).padEnd(10, ' ').trim()
    : 'Sugestão conservadora pela ausência de detalhes.';
  if (out.justificativa.length < 10) {
    out.justificativa = (out.justificativa + ' — sugestão conservadora').slice(0, 200);
  }
  const validTipos = ['intensidade', 'volume', 'manutencao', 'deload'];
  out.tipoProgressao = validTipos.includes(out.tipoProgressao) ? out.tipoProgressao : 'manutencao';
  return out;
}

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}
