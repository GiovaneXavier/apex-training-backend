import { z } from 'zod';

// PR #24 — schemas Zod da Jornada Marcial (BJJ).

export const Faixa = z.enum([
  'BRANCA', 'AZUL', 'ROXA', 'MARROM', 'PRETA', 'CORAL', 'VERMELHA',
]);

export const promocaoCreateSchema = z.object({
  alunoId: z.string().min(1).optional(), // ALUNO usa o próprio; PROFESSOR obriga
  faixa: Faixa,
  // 0..4 stripes (degrau). 5º "stripe" é a próxima faixa.
  grauNum: z.number().int().min(0).max(4).default(0),
  // ISO de quando o atleta recebeu a faixa. Aceita data passada
  // (registro retroativo de promoções históricas) mas trava futuro
  // > 1 dia (clock drift tolerável).
  dataPromocao: z
    .string()
    .datetime()
    .refine((iso) => {
      const t = new Date(iso).getTime();
      return t <= Date.now() + 24 * 60 * 60 * 1000;
    }, 'dataPromocao não pode ser no futuro'),
  instrutorNome: z.string().max(120).optional(),
  observacao: z.string().max(500).optional(),
});

export const promocaoListQuery = z.object({
  alunoId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
