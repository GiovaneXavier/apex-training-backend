import { prisma } from '../lib/prisma.js';
import { HttpError } from '../middleware/errorHandler.js';

// PR #22 — agora aceita filtros `dominio` e `tipoMovimento` pra que o
// picker do RotinaForm consiga isolar a biblioteca BJJ da musculação.
// Índice composto (dominio, tipoMovimento) na migration cobre os 2
// filtros simultâneos sem table scan.
export async function listExercicios({ q, grupo, dominio, tipoMovimento, limit = 200 }) {
  return prisma.exercicio.findMany({
    where: {
      ...(grupo ? { grupoMuscular: grupo } : {}),
      ...(dominio ? { dominio } : {}),
      ...(tipoMovimento ? { tipoMovimento } : {}),
      ...(q ? { nome: { contains: q, mode: 'insensitive' } } : {}),
    },
    orderBy: { nome: 'asc' },
    take: limit,
  });
}

export async function getExercicio(id) {
  const ex = await prisma.exercicio.findUnique({ where: { id } });
  if (!ex) throw new HttpError(404, 'Exercício não encontrado');
  return ex;
}

export async function createExercicio(userId, data) {
  const prof = await prisma.professor.findUnique({ where: { userId } });
  if (!prof) throw new HttpError(403, 'Apenas professores podem criar exercícios');

  // Conflict: nome único
  const existing = await prisma.exercicio.findUnique({ where: { nome: data.nome } });
  if (existing) throw new HttpError(409, 'Já existe exercício com este nome');

  return prisma.exercicio.create({
    data: { ...data, criadoPorId: prof.id },
  });
}

export async function updateExercicio(userId, id, data) {
  const prof = await prisma.professor.findUnique({ where: { userId } });
  if (!prof) throw new HttpError(403, 'Apenas professores podem editar exercícios');
  await getExercicio(id);

  if (data.nome) {
    const dup = await prisma.exercicio.findFirst({
      where: { nome: data.nome, NOT: { id } },
    });
    if (dup) throw new HttpError(409, 'Já existe exercício com este nome');
  }

  return prisma.exercicio.update({ where: { id }, data });
}

export async function deleteExercicio(userId, id) {
  const prof = await prisma.professor.findUnique({ where: { userId } });
  if (!prof) throw new HttpError(403, 'Apenas professores podem excluir exercícios');

  // Bloqueia se em uso por alguma rotina (Restrict no Prisma também faria)
  const usos = await prisma.rotinaExercicio.count({ where: { exercicioId: id } });
  if (usos > 0) {
    throw new HttpError(409, `Exercício em uso por ${usos} rotina(s) — desvincule antes`);
  }

  await prisma.exercicio.delete({ where: { id } });
  return { ok: true };
}
