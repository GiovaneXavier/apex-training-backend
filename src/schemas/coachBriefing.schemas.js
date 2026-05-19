import { z } from 'zod';

// PR #28 — Coach Briefing Semanal.
//
// Schema do payload que o LLM devolve via tool_use. Validado server-side
// antes de persistir no cache. .strict() bloqueia campos desconhecidos —
// LLM não consegue injetar lixo no JSONB.

export const briefingAlertSchema = z
  .object({
    alunoId: z.string().min(1).max(64),
    prioridade: z.enum(['alta', 'media', 'baixa']),
    sinal: z.string().min(3).max(200),
    sugestaoAcao: z.string().min(3).max(200),
  })
  .strict();

export const briefingBomSchema = z
  .object({
    alunoId: z.string().min(1).max(64),
    motivo: z.string().min(3).max(150),
  })
  .strict();

export const briefingResultSchema = z
  .object({
    summary: z.string().min(20).max(500),
    alunosEmAlerta: z.array(briefingAlertSchema).max(10),
    alunosBemEncaminhados: z.array(briefingBomSchema).max(10),
  })
  .strict();

// Snapshot que o serviço de DATA produz e que vira input do LLM.
// Existe pra dar contrato estável (testes) — não vai pra rede.
export const alunoSnapshotSchema = z
  .object({
    alunoId: z.string(),
    nome: z.string(),
    modalidadesAtivas: z.array(z.string()).default([]),
    alertas: z.array(z.object({
      tipo: z.string(),
      severidade: z.enum(['high', 'medium', 'low']),
      detalhe: z.string(),
      desde: z.string().nullable().optional(),
    })).default([]),
    planoAlimentarAtivo: z.boolean().default(false),
    proxProva: z.object({
      nome: z.string(),
      dataAlvo: z.string(),
      diasAte: z.number().int(),
    }).nullable().optional(),
  })
  .passthrough();

export const MAX_ALUNOS_NO_PROMPT = 50;
export const TTL_HOURS = 24;
