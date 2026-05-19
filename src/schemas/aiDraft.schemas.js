import { z } from 'zod';

// PR #30 — AI Plan Drafting (Treino).
//
// REQUEST do endpoint POST /coach/ai-draft/treino:
//   prompt   — descrição livre do coach (3-500 chars). Cap conservador
//              pra evitar prompt injection / abuse de tokens.
//   alunoId  — opcional. Se fornecido, ownership check + contexto leve
//              do aluno entra no prompt do LLM.

export const MAX_DIAS = 7;
export const MAX_EXERCICIOS_POR_DIA = 12;
export const RATE_LIMIT_PER_HOUR = 10;

export const aiDraftTreinoRequestSchema = z
  .object({
    prompt: z.string().min(3).max(500),
    alunoId: z.string().min(1).max(64).optional(),
  })
  .strict();

// OUTPUT do LLM via tool_use draft_treino. Anthropic já validou o
// input_schema (caps numéricos); este Zod é a segunda rede de segurança.

const exercicioRawSchema = z
  .object({
    nome: z.string().min(2).max(80),
    series: z.number().int().min(1).max(8),
    repsRange: z.string().min(1).max(20),
    cargaPctRP: z.number().int().min(30).max(120).nullable(),
    descansoSeg: z.number().int().min(30).max(300),
  })
  .strict();

const diaRawSchema = z
  .object({
    label: z.string().min(1).max(40),
    foco: z.string().min(1).max(60),
    exercicios: z.array(exercicioRawSchema).min(1).max(MAX_EXERCICIOS_POR_DIA),
  })
  .strict();

export const draftTreinoResultSchema = z
  .object({
    titulo: z.string().min(3).max(80),
    objetivoResumo: z.string().min(1).max(200),
    diasSugeridos: z.array(diaRawSchema).min(1).max(MAX_DIAS),
  })
  .strict();
