import Anthropic from '@anthropic-ai/sdk';

import { env } from '../lib/env.js';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../middleware/errorHandler.js';
import { briefingResultSchema, TTL_HOURS } from '../schemas/coachBriefing.schemas.js';

import { buildBriefingSnapshot } from './coachBriefingData.service.js';

// PR #28 — Coach Briefing Semanal.
//
// Orquestra: cache hit? serve. Miss/expirado? coleta snapshot → LLM →
// Zod → fence de IDs → upsert no cache. LLM falhou? serve stale com flag.
//
// Cache TTL 24h por professor (table CoachBriefing). Refresh manual
// bypassa cache via flag `force`.

let _client = null;
function getClient() {
  if (_client) return _client;
  if (!env.ANTHROPIC_API_KEY) {
    throw new HttpError(503, 'Coach briefing indisponível (IA off)');
  }
  _client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  return _client;
}

export function __setClientForTests(client) { _client = client; }
export function __resetClientForTests() { _client = null; }

// ─── System prompt + tool ───────────────────────────────────────────

const SYSTEM_PROMPT = `Você é um assistente que ajuda treinadores de fitness/endurance/BJJ a priorizar atenção em segunda-feira de manhã.

Você recebe a fotografia recente da assessoria do treinador (alunos vinculados, alertas comportamentais detectados, modalidades ativas, próxima prova alvo, status do plano alimentar) e deve devolver um briefing curto e acionável em PORTUGUÊS DO BRASIL.

Regras estritas:
- Use APENAS os dados fornecidos no JSON. Não invente lesões, datas, provas, métricas ou comentários do aluno.
- Para "alunosEmAlerta": só inclua alunos que tenham pelo menos um alerta significativo (severidade high/medium do array "alertas", ou um padrão claro como "modalidade pausada"). MÁX 8 itens. Ordene por prioridade (alta → baixa).
- Para "alunosBemEncaminhados": inclua até 3 alunos SEM alertas mas com sinais positivos (volume de treinos, plano alimentar ativo, prova próxima). MÁX 3 itens.
- "summary": 1 parágrafo (máx 3 frases) com tom de coach experiente — direto, sem clichê. Mencione números quando relevante.
- "sinal" e "sugestaoAcao" devem ser específicos. Evite genéricos como "treinar mais" — diga "perdeu 2 sessões de musculação esta semana, considere reforçar a sessão da quinta".
- Se a assessoria está vazia ou sem dados úteis, devolva summary curto e arrays vazios.
- alunoId: use EXATAMENTE o cuid fornecido no input. Nunca invente.

Chame a tool "submit_briefing".`;

const TOOL_DEF = {
  name: 'submit_briefing',
  description: 'Submete o briefing semanal estruturado.',
  input_schema: {
    type: 'object',
    properties: {
      summary: { type: 'string', maxLength: 500 },
      alunosEmAlerta: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            alunoId: { type: 'string' },
            prioridade: { type: 'string', enum: ['alta', 'media', 'baixa'] },
            sinal: { type: 'string', maxLength: 200 },
            sugestaoAcao: { type: 'string', maxLength: 200 },
          },
          required: ['alunoId', 'prioridade', 'sinal', 'sugestaoAcao'],
        },
      },
      alunosBemEncaminhados: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            alunoId: { type: 'string' },
            motivo: { type: 'string', maxLength: 150 },
          },
          required: ['alunoId', 'motivo'],
        },
      },
    },
    required: ['summary', 'alunosEmAlerta', 'alunosBemEncaminhados'],
    additionalProperties: false,
  },
};

// ─── Cache helpers ──────────────────────────────────────────────────

function isExpired(briefing) {
  if (!briefing?.expiresAt) return true;
  return briefing.expiresAt.getTime() < Date.now();
}

function expiresAtFromNow() {
  return new Date(Date.now() + TTL_HOURS * 60 * 60 * 1000);
}

// ─── Service principal ──────────────────────────────────────────────

/**
 * Retorna briefing pro coach. Cache-aware.
 *
 * @param {object} args
 * @param {{userId: string, role: string}} args.user
 * @param {boolean} [args.force]  Bypass cache (refresh manual).
 *
 * @returns {Promise<{
 *   result: object, generatedAt: Date, expiresAt: Date,
 *   fresh: boolean, stale: boolean, empty: boolean,
 *   alunosVinculadosTotal: number, alunosResiduais: number,
 * }>}
 */
export async function getBriefing({ user, force = false }) {
  if (user.role !== 'PROFESSOR') {
    throw new HttpError(403, 'Apenas professores acessam o briefing');
  }

  const snapshot = await buildBriefingSnapshot({ userId: user.userId });
  if (!snapshot.professorId) {
    throw new HttpError(404, 'Perfil de professor não encontrado');
  }

  // 0 alunos vinculados → atalho sem IA.
  if (snapshot.alunosVinculadosTotal === 0) {
    return {
      result: {
        summary: 'Você ainda não tem alunos vinculados. Convide pela aba de alunos pra começar.',
        alunosEmAlerta: [],
        alunosBemEncaminhados: [],
      },
      generatedAt: new Date(),
      expiresAt: expiresAtFromNow(),
      fresh: true,
      stale: false,
      empty: true,
      alunosVinculadosTotal: 0,
      alunosResiduais: 0,
    };
  }

  const existing = await prisma.coachBriefing.findUnique({
    where: { professorId: snapshot.professorId },
  });

  if (!force && existing && !isExpired(existing)) {
    return {
      result: existing.result,
      generatedAt: existing.generatedAt,
      expiresAt: existing.expiresAt,
      fresh: true,
      stale: false,
      empty: false,
      alunosVinculadosTotal: snapshot.alunosVinculadosTotal,
      alunosResiduais: snapshot.alunosSemSnapshotResidual,
    };
  }

  // Chama LLM. Se falhar, cai pra cache stale (se houver) ou propaga.
  let llmResult;
  try {
    llmResult = await callLLM(snapshot);
  } catch (err) {
    if (existing) {
      // Stale fallback — UX vê briefing antigo com warning, não tela vazia.
      return {
        result: existing.result,
        generatedAt: existing.generatedAt,
        expiresAt: existing.expiresAt,
        fresh: false,
        stale: true,
        empty: false,
        alunosVinculadosTotal: snapshot.alunosVinculadosTotal,
        alunosResiduais: snapshot.alunosSemSnapshotResidual,
      };
    }
    throw err;
  }

  // Fence pós-Zod: filtra alunoIds que não pertencem ao coach. LLM pode
  // alucinar; descarte silencioso + audit log.
  const fenced = fenceAlunoIds(llmResult, snapshot.alunoIdsAutorizados);

  const saved = await prisma.coachBriefing.upsert({
    where: { professorId: snapshot.professorId },
    create: {
      professorId: snapshot.professorId,
      result: fenced,
      meta: {
        modelo: env.ANTHROPIC_MODEL,
        alunosConsiderados: snapshot.snapshots.length,
        alunosResiduais: snapshot.alunosSemSnapshotResidual,
        geradoEm: new Date().toISOString(),
      },
      expiresAt: expiresAtFromNow(),
    },
    update: {
      result: fenced,
      meta: {
        modelo: env.ANTHROPIC_MODEL,
        alunosConsiderados: snapshot.snapshots.length,
        alunosResiduais: snapshot.alunosSemSnapshotResidual,
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
    alunosVinculadosTotal: snapshot.alunosVinculadosTotal,
    alunosResiduais: snapshot.alunosSemSnapshotResidual,
  };
}

async function callLLM(snapshot) {
  const client = getClient();

  const userJson = JSON.stringify({
    alunosVinculadosTotal: snapshot.alunosVinculadosTotal,
    alunosNoPrompt: snapshot.snapshots.length,
    alunosForaDoPrompt: snapshot.alunosSemSnapshotResidual,
    alunos: snapshot.snapshots,
  });

  let response;
  try {
    response = await client.messages.create({
      model: env.ANTHROPIC_MODEL,
      max_tokens: 1500,
      system: [
        // Cache breakpoint: system prompt + tool são estáveis. Hit em
        // chamadas subsequentes derruba custo significativamente.
        { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
      ],
      tools: [TOOL_DEF],
      tool_choice: { type: 'tool', name: 'submit_briefing' },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: `Fotografia atual da assessoria:\n\n${userJson}\n\nGere o briefing chamando submit_briefing.` },
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

  const toolBlock = response.content?.find((b) => b.type === 'tool_use' && b.name === 'submit_briefing');
  if (!toolBlock) throw new HttpError(502, 'IA não devolveu tool_use esperado');

  const parsed = briefingResultSchema.safeParse(toolBlock.input);
  if (!parsed.success) {
    // Tenta limpeza tolerante — alguns campos podem ter passado dos limites.
    // Se mesmo assim falhar, propaga.
    const repaired = tryRepairBriefing(toolBlock.input);
    const reParsed = briefingResultSchema.safeParse(repaired);
    if (!reParsed.success) {
      throw new HttpError(502, 'IA devolveu briefing fora do schema');
    }
    return reParsed.data;
  }
  return parsed.data;
}

function tryRepairBriefing(raw) {
  if (!raw || typeof raw !== 'object') return raw;
  const out = { ...raw };
  if (typeof out.summary === 'string') {
    out.summary = out.summary.slice(0, 500);
    if (out.summary.length < 20) out.summary = out.summary.padEnd(20, ' ').trim() + ' (briefing curto)';
  }
  if (Array.isArray(out.alunosEmAlerta)) {
    out.alunosEmAlerta = out.alunosEmAlerta.slice(0, 10).map((a) => ({
      alunoId: String(a?.alunoId || '').slice(0, 64),
      prioridade: ['alta', 'media', 'baixa'].includes(a?.prioridade) ? a.prioridade : 'media',
      sinal: String(a?.sinal || '').slice(0, 200),
      sugestaoAcao: String(a?.sugestaoAcao || '').slice(0, 200),
    })).filter((a) => a.sinal.length >= 3 && a.sugestaoAcao.length >= 3);
  } else {
    out.alunosEmAlerta = [];
  }
  if (Array.isArray(out.alunosBemEncaminhados)) {
    out.alunosBemEncaminhados = out.alunosBemEncaminhados.slice(0, 10).map((a) => ({
      alunoId: String(a?.alunoId || '').slice(0, 64),
      motivo: String(a?.motivo || '').slice(0, 150),
    })).filter((a) => a.motivo.length >= 3);
  } else {
    out.alunosBemEncaminhados = [];
  }
  return out;
}

function fenceAlunoIds(result, alunoIdsAutorizados) {
  const dropped = { alerta: 0, bom: 0 };

  const alertaFiltrada = result.alunosEmAlerta.filter((a) => {
    if (alunoIdsAutorizados.has(a.alunoId)) return true;
    dropped.alerta++;
    return false;
  });
  const bomFiltrada = result.alunosBemEncaminhados.filter((a) => {
    if (alunoIdsAutorizados.has(a.alunoId)) return true;
    dropped.bom++;
    return false;
  });

  if (dropped.alerta > 0 || dropped.bom > 0) {
    console.warn(JSON.stringify({
      level: 'warn',
      msg: 'coach-briefing-id-fence',
      droppedEmAlerta: dropped.alerta,
      droppedBom: dropped.bom,
    }));
  }

  return {
    summary: result.summary,
    alunosEmAlerta: alertaFiltrada,
    alunosBemEncaminhados: bomFiltrada,
  };
}
