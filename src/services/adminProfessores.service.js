// PR #44 (Sprint 16 — Bloco C) — Listagem de professores ativos pro
// dropdown de "Trocar professor" no drawer admin.
//
// Endpoint dedicado (D6) em vez de reusar /admin/users — retorna direto
// Professor.id (não User.id) eliminando round-trip de mapeamento no
// frontend.

import { prisma } from '../lib/prisma.js';

export async function listarProfessoresAtivos({ search, limit }) {
  const where = { user: { ativo: true, role: 'PROFESSOR' } };
  if (search) {
    where.user = {
      ...where.user,
      OR: [
        { nome: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
      ],
    };
  }

  const rows = await prisma.professor.findMany({
    where,
    take: limit,
    orderBy: { user: { nome: 'asc' } },
    select: {
      id: true,
      user: { select: { nome: true, email: true } },
    },
  });

  // Flatten — frontend recebe {id, nome, email} pronto pra render.
  return {
    professores: rows.map((p) => ({
      id: p.id,
      nome: p.user.nome,
      email: p.user.email,
    })),
  };
}
