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

// PR #44 — Bloco C: Overrides de vínculo
// ──────────────────────────────────────────────────────────────────────

export const alunoIdParam = z.object({
  alunoId: z.string().min(1).max(64),
});

// PUT substitui o vínculo. `motivo` é opcional (D7) mas validado se
// vier — string longa demais pode poluir o audit. 500 chars cobre
// "Professor X saiu da plataforma em 24/05, aluno migrou pra Y após
// orientação do head coach. Confirmado por email."
export const substituirVinculoBody = z.object({
  professorId: z.string().min(1).max(64),
  motivo: z.string().trim().min(1).max(500).optional(),
});

export const removerVinculoBody = z.object({
  motivo: z.string().trim().min(1).max(500).optional(),
});

export const listProfessoresQuery = z.object({
  search: z.string().trim().min(1).max(120).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

// PR #45 — Bloco D: Audit log viewer
// ──────────────────────────────────────────────────────────────────────

export const listAuditQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).max(512).optional(),
  // action é string livre (polimórfica) — validação só de tamanho
  // pra evitar payloads abusivos.
  action: z.string().trim().min(1).max(64).optional(),
  entityType: z.string().trim().min(1).max(64).optional(),
  entityId: z.string().trim().min(1).max(64).optional(),
  atorUserId: z.string().trim().min(1).max(64).optional(),
  desde: z.string().datetime().optional(),
  ate: z.string().datetime().optional(),
});
