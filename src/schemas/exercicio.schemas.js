import { z } from 'zod';

export const GrupoMuscular = z.enum([
  'PEITO', 'COSTAS', 'OMBRO', 'BICEPS', 'TRICEPS', 'ANTEBRACO',
  'ABDOMEN', 'GLUTEO', 'QUADRICEPS', 'POSTERIOR', 'PANTURRILHA',
  'CARDIO', 'CORE', 'OUTRO',
]);

// PR #22 — domínios do catálogo. MUSCULACAO mantém comportamento legado;
// JIU_JITSU é o domínio que entra agora; MOBILIDADE/OUTRO ficam disponíveis
// pra mestres adicionarem aquecimentos/alongamentos compartilháveis.
export const DominioExercicio = z.enum([
  'MUSCULACAO', 'JIU_JITSU', 'MOBILIDADE', 'OUTRO',
]);

// PR #22 — tipo do movimento (granularidade do BJJ).
// Hoje só popula em JIU_JITSU; controladores ignoram em outros domínios.
export const TipoMovimento = z.enum([
  'DRILL', 'PASSAGEM', 'GUARDA', 'RASPAGEM', 'SUBMISSAO', 'ENTRADA', 'SAIDA',
]);

export const exercicioCreateSchema = z.object({
  nome: z.string().min(2).max(120).trim(),
  videoUrl: z.string().url().optional().or(z.literal('').transform(() => undefined)),
  imagemUrl: z.string().url().optional().or(z.literal('').transform(() => undefined)),
  grupoMuscular: GrupoMuscular.optional(),
  equipamento: z.string().max(80).optional(),
  instrucoes: z.string().max(1000).optional(),
  // PR #22 — campos novos. `dominio` default MUSCULACAO espelha o
  // default da coluna no banco (não-quebra clients antigos).
  dominio: DominioExercicio.default('MUSCULACAO'),
  // Texto livre — BJJ usa terminologia regional ("guarda fechada",
  // "100 quilos", "norte-sul"). Cap em 80 evita inflar.
  posicao: z.string().max(80).optional(),
  tipoMovimento: TipoMovimento.optional(),
});

export const exercicioUpdateSchema = exercicioCreateSchema.partial();

export const exercicioListQuery = z.object({
  q: z.string().trim().optional(),
  grupo: GrupoMuscular.optional(),
  // PR #22 — filtros do picker BJJ.
  dominio: DominioExercicio.optional(),
  tipoMovimento: TipoMovimento.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
