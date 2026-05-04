import { z } from 'zod';

import { prisma } from '../lib/prisma.js';
import { resolveAlunoAccess } from '../lib/access.js';

export const listRPsQuery = z.object({
  exercicio: z.string().trim().optional(),
  modalidade: z.enum(['MUSCULACAO', 'CORRIDA', 'CICLISMO', 'NATACAO', 'TRIATHLON', 'OUTRO']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

export async function listRPsByAluno({ user, alunoId, filters }) {
  const aluno = await resolveAlunoAccess({ user, alunoId });
  const where = { alunoId: aluno.id };
  if (filters.exercicio) where.exercicio = filters.exercicio;
  if (filters.modalidade) where.modalidade = filters.modalidade;

  const records = await prisma.recordePessoal.findMany({
    where,
    orderBy: [{ exercicio: 'asc' }, { reps: 'asc' }, { dataRecorde: 'desc' }],
    take: filters.limit ?? 200,
  });

  // Agrupa por exercício para a UI mostrar histórico por exercício.
  const byExercicio = new Map();
  for (const r of records) {
    if (!byExercicio.has(r.exercicio)) byExercicio.set(r.exercicio, []);
    byExercicio.get(r.exercicio).push(r);
  }

  const grouped = Array.from(byExercicio.entries()).map(([exercicio, rs]) => {
    // Para cada exercício: top RP global = maior valor; e melhor por reps
    const top = rs.reduce((max, r) => (r.valor > max.valor ? r : max), rs[0]);
    const porReps = new Map();
    for (const r of rs) {
      const k = r.reps ?? 0;
      if (!porReps.has(k) || porReps.get(k).valor < r.valor) porReps.set(k, r);
    }
    return {
      exercicio,
      modalidade: top.modalidade,
      top,
      porReps: Array.from(porReps.values()).sort((a, b) => (a.reps ?? 0) - (b.reps ?? 0)),
      historico: rs,
    };
  });

  return { records, grouped };
}
