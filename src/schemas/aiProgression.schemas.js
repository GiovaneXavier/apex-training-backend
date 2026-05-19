import { z } from 'zod';

// PR #29 — AI Progression Suggestion.
//
// REQUEST (body do POST /coach/ai-progression/exercise):
//   alunoId  — cuid do aluno alvo. Ownership checado no service.
//   exercicioNome — nome canonical do exercício (mesma chave do GIN no JSON).
//   modalidade — pra discriminar musculação (kg+reps) de calistenia/condicional.
//                Default MUSCULACAO mantém retrocompat com o caso dominante.

export const aiProgressionRequestSchema = z
  .object({
    alunoId: z.string().min(1).max(64),
    exercicioNome: z.string().min(1).max(120),
    modalidade: z.enum(['MUSCULACAO', 'CALISTENIA']).default('MUSCULACAO'),
  })
  .strict();

// OUTPUT do LLM via tool_use submit_progression.
// .strict() rejeita campos extras — anti storage poisoning aplicado no
// payload de IA também (mesmo padrão dos schemas de execução).
//
// `tipoProgressao` discrimina a INTENÇÃO da sugestão pra UX colorir badge
// e o coach captar a estratégia sem ler a justificativa:
//   intensidade → subir kg
//   volume      → mais sets/reps na mesma carga
//   manutencao  → repetir (estabilizar antes de subir)
//   deload      → recuar intensidade ou volume

export const suggestedProgressionSchema = z
  .object({
    sets: z.number().int().min(1).max(10),
    reps: z.string().min(1).max(20),                   // "8-10", "AMRAP", "Fadiga", "30s"
    cargaEstimadaKg: z.number().nonnegative().max(2000).nullable(),
    rpeAlvo: z.number().min(1).max(10).nullable(),
    justificativa: z.string().min(10).max(200),
    tipoProgressao: z.enum(['intensidade', 'volume', 'manutencao', 'deload']),
  })
  .strict();

// Snapshot interno que o data service produz e o llm service consome.
// Existe pra dar contrato estável a testes — não vai pra rede.
export const exercicioHistoricoSchema = z
  .object({
    dataAlvo: z.string(),                              // ISO
    sets: z.array(z.object({
      kg: z.number().nullable().optional(),
      reps: z.number().int().nonnegative().nullable().optional(),
      rpe: z.number().min(0).max(10).nullable().optional(),
    })).default([]),
  })
  .passthrough();

export const RATE_LIMIT_PER_HOUR = 30;
export const MAX_EXECUCOES_HISTORICO = 5;
