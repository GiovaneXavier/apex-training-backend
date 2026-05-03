import { z } from 'zod';

export const Modalidade = z.enum([
  'MUSCULACAO',
  'CORRIDA',
  'CICLISMO',
  'NATACAO',
  'TRIATHLON',
  'OUTRO',
]);

export const StatusTreino = z.enum(['PENDENTE', 'EM_EXECUCAO', 'CONCLUIDO', 'PULADO']);

// ─────────────────────────────────────────────────────────────
// Detalhes JSON — discriminated union por `tipo`
// ─────────────────────────────────────────────────────────────
const exercicioPrescrito = z.object({
  series: z.number().int().positive(),
  reps: z.number().int().positive().optional(),
  repsMin: z.number().int().positive().optional(),
  repsMax: z.number().int().positive().optional(),
  cargaPctRP: z.number().min(0).max(200).optional(),
  cargaKg: z.number().nonnegative().optional(),
  descansoSeg: z.number().int().nonnegative().optional(),
  observacao: z.string().max(500).optional(),
});

const setRealizado = z.object({
  kg: z.number().nonnegative().optional(),
  reps: z.number().int().nonnegative().optional(),
  rpe: z.number().min(0).max(10).optional(),
  observacao: z.string().max(200).optional(),
  registradoEm: z.string().datetime().optional(),
});

const exercicioMusc = z.object({
  nome: z.string().min(1).max(120),
  videoUrl: z.string().url().optional(),
  prescrito: exercicioPrescrito,
  realizado: z.array(setRealizado).optional().default([]),
  observacao: z.string().max(500).optional(),
});

export const detalhesMusculacao = z.object({
  tipo: z.literal('musculacao'),
  exercicios: z.array(exercicioMusc).min(1),
  observacao: z.string().max(500).optional(),
});

export const detalhesCorrida = z.object({
  tipo: z.literal('corrida'),
  distanciaKm: z.number().positive(),
  ritmoAlvoMinKm: z.string().regex(/^\d{1,2}:\d{2}$/, 'Formato MM:SS').optional(),
  fcAlvoMin: z.number().int().positive().optional(),
  fcAlvoMax: z.number().int().positive().optional(),
  realizado: z
    .object({
      distanciaKm: z.number().nonnegative().optional(),
      duracaoSeg: z.number().int().nonnegative().optional(),
      ritmoMedioMinKm: z.string().optional(),
      fcMedia: z.number().int().nonnegative().optional(),
      stravaActivityId: z.string().optional(),
    })
    .nullable()
    .optional(),
  observacao: z.string().max(500).optional(),
});

export const detalhesCiclismo = z.object({
  tipo: z.literal('ciclismo'),
  distanciaKm: z.number().positive(),
  duracaoMin: z.number().positive().optional(),
  potenciaAlvoW: z.number().nonnegative().optional(),
  realizado: z
    .object({
      distanciaKm: z.number().nonnegative().optional(),
      duracaoSeg: z.number().int().nonnegative().optional(),
      potenciaMediaW: z.number().nonnegative().optional(),
      stravaActivityId: z.string().optional(),
    })
    .nullable()
    .optional(),
  observacao: z.string().max(500).optional(),
});

export const detalhesNatacao = z.object({
  tipo: z.literal('natacao'),
  series: z
    .array(
      z.object({
        repeticoes: z.number().int().positive(),
        distanciaM: z.number().positive(),
        estilo: z.enum(['LIVRE', 'COSTAS', 'PEITO', 'BORBOLETA', 'MEDLEY']).optional(),
        descansoSeg: z.number().int().nonnegative().optional(),
      }),
    )
    .min(1),
  realizado: z
    .object({
      distanciaTotalM: z.number().nonnegative().optional(),
      duracaoSeg: z.number().int().nonnegative().optional(),
      observacao: z.string().max(300).optional(),
    })
    .nullable()
    .optional(),
});

export const detalhesTriathlon = z.object({
  tipo: z.literal('triathlon'),
  blocos: z
    .array(
      z.discriminatedUnion('tipo', [
        detalhesNatacao,
        detalhesCiclismo,
        detalhesCorrida,
      ]),
    )
    .min(2),
  observacao: z.string().max(500).optional(),
});

export const detalhesOutro = z.object({
  tipo: z.literal('outro'),
  descricao: z.string().min(1).max(2000),
  realizado: z.string().max(2000).nullable().optional(),
});

// Discriminated union — o "superpoder" do JSON.
export const treinoDetalhes = z.discriminatedUnion('tipo', [
  detalhesMusculacao,
  detalhesCorrida,
  detalhesCiclismo,
  detalhesNatacao,
  detalhesTriathlon,
  detalhesOutro,
]);

// ─────────────────────────────────────────────────────────────
// Schemas de entidade
// ─────────────────────────────────────────────────────────────
export const prescreverSchema = z.object({
  alunoId: z.string().min(1),
  modalidade: Modalidade,
  titulo: z.string().min(1).max(200).trim(),
  dataAlvo: z.string().datetime(),
  detalhes: treinoDetalhes,
});

export const listTreinosQuery = z.object({
  status: StatusTreino.optional(),
  desde: z.string().datetime().optional(),
  ate: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
