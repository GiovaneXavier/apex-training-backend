import Anthropic from '@anthropic-ai/sdk';

import { env } from '../lib/env.js';
import { HttpError } from '../middleware/errorHandler.js';
import { matchExerciciosBatch } from '../lib/exercicioMatch.js';
import { prisma } from '../lib/prisma.js';
import {
  draftTreinoResultSchema,
  MAX_DIAS,
  MAX_EXERCICIOS_POR_DIA,
} from '../schemas/aiDraft.schemas.js';

// PR #30 — Geração de esqueleto de rotina via IA.
//
// Pipeline:
//   1. ACL (PROFESSOR).
//   2. Feature flag ANTHROPIC.
//   3. Ownership check se alunoId fornecido (anti billing-drain).
//   4. Contexto opcional do aluno (último treinos, RPs).
//   5. LLM call — system cached + tool_use forçado.
//   6. Zod draftTreinoResultSchema (estrito + repair tolerante).
//   7. Extrai nomes únicos → matchExerciciosBatch.
//   8. Hidrata cada exercício com {exercicioId, nomeCanonico, similarityScore, confianca}.
//   9. Computa meta { matchesVerde, matchesLaranja, matchesVermelho }.
//  10. Retorna payload completo. SEM persistência (HITL puro).

// ─── Cliente Anthropic singleton + test hook ─────────────────────────

let _client = null;
function getClient() {
  if (_client) return _client;
  if (!env.ANTHROPIC_API_KEY) throw new HttpError(503, 'AI Draft indisponível (IA off)');
  _client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  return _client;
}
export function __setClientForTests(c) { _client = c; }
export function __resetClientForTests() { _client = null; }

// ─── System prompt + tool ────────────────────────────────────────────

const SYSTEM_PROMPT_DRAFT_TREINO = `Você é um assistente que monta ESQUELETOS de rotinas de musculação a partir de descrição em linguagem natural fornecida pelo treinador (PT-BR).

OBJETIVO: devolver um draft que o treinador vai REVISAR — você NÃO substitui o humano. Foco em estrutura coerente, não em micro-detalhe perfeito.

Princípios de programação (siga TODOS):

1. NOMES CANÔNICOS PT-BR populares: "Supino Inclinado com Halteres" (não "Bench Press Inclined Dumbbell"). O backend faz fuzzy matching contra o catálogo do app — quanto mais convencional o nome, melhor a probabilidade de match silencioso.

2. Volume sensato: 4-8 exercícios/dia. Compostos (agachamento, supino, terra, remada) ANTES de isolados (rosca, tríceps testa). NÃO invente exercícios exóticos.

3. Distribuição semanal coerente com o foco descrito:
   - "ABCD" / 4 dias → 4 dias
   - "ABC" / 3 dias → 3 dias
   - "AB" / push-pull / upper-lower → 2 dias
   - "Full body" → 3-4 dias com mesma estrutura

4. Reps coerentes com objetivo declarado:
   - Hipertrofia (default): 8-12
   - Força: 3-6
   - Resistência/condicionamento: 12-20

5. cargaPctRP: preencha NUMÉRICO somente se a descrição mencionar intensidade explícita ("65%", "leve", "pesado"). Caso contrário, null — coach define depois com o histórico em mãos.

6. descansoSeg coerente:
   - Força: 120-180s
   - Hipertrofia: 60-90s
   - Condicionamento: 30-60s

7. Se a descrição mencionar dor/lesão/restrição, EVITE exercícios contraindicados. Ex: lesão lombar → fora "Levantamento Terra Convencional"; ombro irritado → fora "Desenvolvimento Militar".

8. 'foco' por dia: resuma em 1-3 palavras ("Peito/Tríceps", "Pernas posterior", "Pull").

9. Se receber CONTEXTO DO ALUNO (histórico recente, RPs, alvo de prova), USE como guia: modalidades familiares, intensidade calibrada por RP recente, evite movimentos com lesão registrada.

10. NÃO invente histórico, RPs, lesões ou dados que não foram fornecidos.

Saída APENAS via tool draft_treino. Sem texto fora da tool.`;

const TOOL_DEF = {
  name: 'draft_treino',
  description: 'Submete o esqueleto da rotina de musculação para revisão do treinador.',
  input_schema: {
    type: 'object',
    properties: {
      titulo: { type: 'string', minLength: 3, maxLength: 80 },
      objetivoResumo: { type: 'string', maxLength: 200 },
      diasSugeridos: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_DIAS,
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', maxLength: 40 },
            foco: { type: 'string', maxLength: 60 },
            exercicios: {
              type: 'array',
              minItems: 1,
              maxItems: MAX_EXERCICIOS_POR_DIA,
              items: {
                type: 'object',
                properties: {
                  nome: { type: 'string', minLength: 2, maxLength: 80 },
                  series: { type: 'integer', minimum: 1, maximum: 8 },
                  repsRange: { type: 'string', minLength: 1, maxLength: 20 },
                  cargaPctRP: { type: ['integer', 'null'], minimum: 30, maximum: 120 },
                  descansoSeg: { type: 'integer', minimum: 30, maximum: 300 },
                },
                required: ['nome', 'series', 'repsRange', 'cargaPctRP', 'descansoSeg'],
                additionalProperties: false,
              },
            },
          },
          required: ['label', 'foco', 'exercicios'],
          additionalProperties: false,
        },
      },
    },
    required: ['titulo', 'objetivoResumo', 'diasSugeridos'],
    additionalProperties: false,
  },
};

// ─── Service principal ──────────────────────────────────────────────

/**
 * Gera draft de rotina de treino.
 *
 * @param {object} args
 * @param {{userId: string, role: string}} args.user
 * @param {string} args.prompt
 * @param {string} [args.alunoId]
 */
export async function generateDraftTreino({ user, prompt, alunoId }) {
  if (user.role !== 'PROFESSOR') {
    throw new HttpError(403, 'Apenas professores podem usar o AI Draft');
  }
  if (!env.ANTHROPIC_API_KEY) {
    throw new HttpError(503, 'AI Draft indisponível (IA off)');
  }

  // Ownership pré-LLM. Sem alunoId → modo "rotina genérica", OK pular.
  if (alunoId) {
    const ok = await checkProfessorOwnership({ userId: user.userId, alunoId });
    if (!ok) throw new HttpError(403, 'Aluno não vinculado a este professor');
  }

  const contexto = alunoId ? await buildContextoAluno(alunoId) : null;

  const llmRaw = await callLLM({ prompt, contexto });

  // Zod estrito → repair tolerante.
  let draft;
  const parsed = draftTreinoResultSchema.safeParse(llmRaw);
  if (parsed.success) {
    draft = parsed.data;
  } else {
    const repaired = tryRepair(llmRaw);
    const reParsed = draftTreinoResultSchema.safeParse(repaired);
    if (!reParsed.success) {
      throw new HttpError(502, 'IA devolveu draft fora do schema');
    }
    draft = reParsed.data;
  }

  // Extrai nomes únicos preservando ordem de aparição (pra fuzzy match
  // batch em uma chamada SQL).
  const nomesPlanos = [];
  for (const dia of draft.diasSugeridos) {
    for (const ex of dia.exercicios) nomesPlanos.push(ex.nome);
  }
  const matches = await matchExerciciosBatch(nomesPlanos);

  // Hidrata os exercícios. matches[i] alinha com nomesPlanos[i] (mesma ordem).
  let idx = 0;
  let matchesVerde = 0;
  let matchesLaranja = 0;
  let matchesVermelho = 0;
  const diasHidratados = draft.diasSugeridos.map((dia) => ({
    label: dia.label,
    foco: dia.foco,
    exercicios: dia.exercicios.map((ex) => {
      const m = matches[idx++];
      if (m.confianca === 'verde') matchesVerde++;
      else if (m.confianca === 'laranja') matchesLaranja++;
      else matchesVermelho++;
      return {
        ...ex,
        exercicioId: m.exercicioId,
        nomeCanonico: m.nomeCanonico,
        similarityScore: m.similarityScore,
        confianca: m.confianca,
      };
    }),
  }));

  return {
    titulo: draft.titulo,
    objetivoResumo: draft.objetivoResumo,
    diasSugeridos: diasHidratados,
    meta: {
      modelo: env.ANTHROPIC_MODEL,
      exerciciosUnicos: new Set(nomesPlanos).size,
      matchesVerde,
      matchesLaranja,
      matchesVermelho,
    },
  };
}

// ─── Helpers ────────────────────────────────────────────────────────

async function checkProfessorOwnership({ userId, alunoId }) {
  const prof = await prisma.professor.findUnique({
    where: { userId }, select: { id: true },
  });
  if (!prof) return false;
  const v = await prisma.vinculoProfessor.findUnique({
    where: { alunoId_professorId: { alunoId, professorId: prof.id } },
    select: { id: true },
  });
  return !!v;
}

// Contexto LEVE do aluno — só sinais agregados. Sem PII além do nome
// encurtado (mesmo padrão dos PRs anteriores).
async function buildContextoAluno(alunoId) {
  const aluno = await prisma.aluno.findUnique({
    where: { id: alunoId },
    select: {
      user: { select: { nome: true } },
      recordes: {
        select: { exercicio: true, valor: true, unidade: true, reps: true },
        where: { modalidade: 'MUSCULACAO' },
        take: 8,
        orderBy: { dataRecorde: 'desc' },
      },
    },
  });
  if (!aluno) return null;
  return {
    nome: encurtarNome(aluno.user?.nome ?? '—'),
    rpsRecentesMusculacao: aluno.recordes.map((r) => ({
      exercicio: r.exercicio,
      valor: r.valor,
      unidade: r.unidade,
      reps: r.reps,
    })),
  };
}

function encurtarNome(nome) {
  const parts = String(nome).trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '—';
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
}

async function callLLM({ prompt, contexto }) {
  const client = getClient();

  const userPayload = contexto
    ? { descricao: prompt, contextoAluno: contexto }
    : { descricao: prompt };

  let response;
  try {
    response = await client.messages.create({
      model: env.ANTHROPIC_MODEL,
      max_tokens: 2500,
      system: [
        { type: 'text', text: SYSTEM_PROMPT_DRAFT_TREINO, cache_control: { type: 'ephemeral' } },
      ],
      tools: [TOOL_DEF],
      tool_choice: { type: 'tool', name: 'draft_treino' },
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Monte o esqueleto da rotina chamando draft_treino.\n\nDescrição do treinador:\n${JSON.stringify(userPayload, null, 2)}`,
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

  const tool = response.content?.find((b) => b.type === 'tool_use' && b.name === 'draft_treino');
  if (!tool) throw new HttpError(502, 'IA não devolveu tool_use esperado');
  return tool.input || {};
}

// Repair tolerante — clamp, recorta e descarta lixo. Não invariada — só
// preserva estrutura mínima válida pro Zod aceitar na 2ª passada.
function tryRepair(raw) {
  if (!raw || typeof raw !== 'object') return raw;
  const out = { ...raw };
  out.titulo = clampStr(out.titulo, 3, 80, 'Rotina sugerida');
  out.objetivoResumo = clampStr(out.objetivoResumo, 1, 200, 'Objetivo não especificado');
  if (Array.isArray(out.diasSugeridos)) {
    out.diasSugeridos = out.diasSugeridos
      .slice(0, MAX_DIAS)
      .map(repairDia)
      .filter((d) => d.exercicios.length > 0);
  } else {
    out.diasSugeridos = [];
  }
  return out;
}

function repairDia(d) {
  if (!d || typeof d !== 'object') return { label: 'Dia', foco: 'Geral', exercicios: [] };
  return {
    label: clampStr(d.label, 1, 40, 'Dia'),
    foco: clampStr(d.foco, 1, 60, 'Geral'),
    exercicios: Array.isArray(d.exercicios)
      ? d.exercicios.slice(0, MAX_EXERCICIOS_POR_DIA).map(repairExercicio).filter(Boolean)
      : [],
  };
}

function repairExercicio(e) {
  if (!e || typeof e !== 'object') return null;
  const nome = clampStr(e.nome, 2, 80, '');
  if (!nome) return null;
  return {
    nome,
    series: clampInt(e.series, 1, 8, 3),
    repsRange: clampStr(e.repsRange, 1, 20, '8-12'),
    cargaPctRP: typeof e.cargaPctRP === 'number'
      ? clampInt(e.cargaPctRP, 30, 120, null)
      : null,
    descansoSeg: clampInt(e.descansoSeg, 30, 300, 60),
  };
}

function clampStr(v, min, max, fallback) {
  if (typeof v !== 'string') return fallback;
  const t = v.slice(0, max);
  return t.length >= min ? t : fallback;
}

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}
