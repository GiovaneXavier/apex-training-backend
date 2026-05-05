import { z } from 'zod';

export const GrupoMuscular = z.enum([
  'PEITO', 'COSTAS', 'OMBRO', 'BICEPS', 'TRICEPS', 'ANTEBRACO',
  'ABDOMEN', 'GLUTEO', 'QUADRICEPS', 'POSTERIOR', 'PANTURRILHA',
  'CARDIO', 'CORE', 'OUTRO',
]);

export const exercicioCreateSchema = z.object({
  nome: z.string().min(2).max(120).trim(),
  videoUrl: z.string().url().optional().or(z.literal('').transform(() => undefined)),
  imagemUrl: z.string().url().optional().or(z.literal('').transform(() => undefined)),
  grupoMuscular: GrupoMuscular.optional(),
  equipamento: z.string().max(80).optional(),
  instrucoes: z.string().max(1000).optional(),
});

export const exercicioUpdateSchema = exercicioCreateSchema.partial();

export const exercicioListQuery = z.object({
  q: z.string().trim().optional(),
  grupo: GrupoMuscular.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
