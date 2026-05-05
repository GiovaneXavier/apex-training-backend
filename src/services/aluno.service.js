import { prisma } from '../lib/prisma.js';
import { HttpError } from '../middleware/errorHandler.js';

async function getAluno(userId) {
  const a = await prisma.aluno.findUnique({ where: { userId } });
  if (!a) throw new HttpError(404, 'Perfil de aluno não encontrado');
  return a;
}

// ── Vínculos com nutricionistas ────────────────────────────────
export async function listarVinculosNutri(userId) {
  const aluno = await getAluno(userId);
  const vs = await prisma.vinculoNutricionista.findMany({
    where: { alunoId: aluno.id },
    orderBy: { criadoEm: 'desc' },
    include: {
      nutricionista: { include: { user: { select: { nome: true, email: true, avatarUrl: true } } } },
    },
  });
  return vs.map((v) => ({
    vinculoId: v.id,
    nutricionistaId: v.nutricionistaId,
    nome: v.nutricionista.user.nome,
    email: v.nutricionista.user.email,
    avatarUrl: v.nutricionista.user.avatarUrl,
    crn: v.nutricionista.crn,
    aceito: v.aceitoPeloAluno,
    desde: v.criadoEm,
  }));
}

export async function aceitarVinculoNutri(userId, vinculoId) {
  const aluno = await getAluno(userId);
  const v = await prisma.vinculoNutricionista.findUnique({ where: { id: vinculoId } });
  if (!v) throw new HttpError(404, 'Vínculo não encontrado');
  if (v.alunoId !== aluno.id) throw new HttpError(403, 'Vínculo de outro aluno');
  if (v.aceitoPeloAluno) return { ok: true, jaAceito: true };
  await prisma.vinculoNutricionista.update({
    where: { id: vinculoId },
    data: { aceitoPeloAluno: true },
  });
  return { ok: true };
}

export async function recusarVinculoNutri(userId, vinculoId) {
  const aluno = await getAluno(userId);
  const v = await prisma.vinculoNutricionista.findUnique({ where: { id: vinculoId } });
  if (!v) throw new HttpError(404, 'Vínculo não encontrado');
  if (v.alunoId !== aluno.id) throw new HttpError(403, 'Vínculo de outro aluno');
  await prisma.vinculoNutricionista.delete({ where: { id: vinculoId } });
  return { ok: true };
}

// ── Vínculos com professores (visualizar) ──────────────────────
export async function listarVinculosProfessor(userId) {
  const aluno = await getAluno(userId);
  const vs = await prisma.vinculoProfessor.findMany({
    where: { alunoId: aluno.id },
    orderBy: { criadoEm: 'desc' },
    include: {
      professor: { include: { user: { select: { nome: true, email: true, avatarUrl: true } } } },
    },
  });
  return vs.map((v) => ({
    vinculoId: v.id,
    professorId: v.professorId,
    nome: v.professor.user.nome,
    email: v.professor.user.email,
    avatarUrl: v.professor.user.avatarUrl,
    bio: v.professor.bio,
    desde: v.criadoEm,
  }));
}
