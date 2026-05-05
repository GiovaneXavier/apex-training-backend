import { z } from 'zod';

const setRealizadoSchema = z.object({
  kg: z.number().nonnegative().optional(),
  reps: z.number().int().nonnegative().optional(),
  rpe: z.number().min(0).max(10).optional(),
  observacao: z.string().max(200).optional(),
  registradoEm: z.string().datetime().optional(),
});

export const salvarExecucaoSchema = z.object({
  // Para musculação: lista de exercicios com realizado
  exercicios: z
    .array(
      z.object({
        nome: z.string().min(1).max(120),
        realizado: z.array(setRealizadoSchema).default([]),
      }),
    )
    .optional(),

  // Para outras modalidades: bloco realizado livre (corrida/ciclismo/natação)
  realizado: z.record(z.unknown()).optional(),

  status: z.enum(['CONCLUIDO', 'PULADO']).default('CONCLUIDO'),
  finalizadoEm: z.string().datetime().optional(),
});
