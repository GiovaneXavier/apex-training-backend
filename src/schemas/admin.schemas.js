import { z } from 'zod';

// PR #43 — Schemas Zod do Cockpit Admin · Bloco B.
//
// roleEnum espelha Prisma Role (sem duplicar — mantém consistência se
// surgir role nova). `ativo` no query vem como string ("true"/"false")
// porque querystring é texto puro; `coerce.boolean` aceita ambos os
// formatos sem fricção.

export const roleEnum = z.enum(['ALUNO', 'PROFESSOR', 'NUTRICIONISTA', 'ADMIN']);

export const listUsersQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  // cursor opaco — backend valida shape em decodeCursor; aqui só checa
  // tamanho razoável pra rejeitar payload abusivo antes de decodificar.
  cursor: z.string().min(1).max(512).optional(),
  // search aplicado em nome OR email (ILIKE). Limite anti-pattern de
  // queries massivas. Trim no service.
  search: z.string().trim().min(1).max(120).optional(),
  role: roleEnum.optional(),
  // .optional() deixa undefined passar; preprocess aceita string ou bool.
  // coerce.boolean trataria "false" como true (bug clássico do Zod),
  // por isso refinamos manualmente.
  ativo: z
    .preprocess((v) => {
      if (v === undefined || v === '') return undefined;
      if (typeof v === 'boolean') return v;
      if (v === 'true') return true;
      if (v === 'false') return false;
      return v;
    }, z.boolean().optional()),
});

export const userIdParam = z.object({
  id: z.string().min(1).max(64),
});

export const updateStatusBody = z.object({
  ativo: z.boolean(),
});
