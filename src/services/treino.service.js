import { prisma } from '../lib/prisma.js';
import { HttpError } from '../middleware/errorHandler.js';

// Resolve qual `Aluno.id` o usuário corrente pode ver/gravar.
// - Aluno: só o próprio.
// - Professor: precisa estar vinculado.
// - Nutricionista: leitura mediante aceite.
async function resolveAlunoAccess({ user, alunoId, write = false }) {
  if (user.role === 'ALUNO') {
    const aluno = await prisma.aluno.findUnique({ where: { userId: user.userId } });
    if (!aluno) throw new HttpError(404, 'Perfil de aluno não encontrado');
    if (alunoId && alunoId !== aluno.id) throw new HttpError(403, 'Acesso negado');
    return aluno;
  }

  if (!alunoId) throw new HttpError(400, 'alunoId obrigatório');

  if (user.role === 'PROFESSOR') {
    const prof = await prisma.professor.findUnique({ where: { userId: user.userId } });
    if (!prof) throw new HttpError(404, 'Perfil de professor não encontrado');
    const vinculo = await prisma.vinculoProfessor.findUnique({
      where: { alunoId_professorId: { alunoId, professorId: prof.id } },
    });
    if (!vinculo) throw new HttpError(403, 'Aluno não vinculado a este professor');
    const aluno = await prisma.aluno.findUnique({ where: { id: alunoId } });
    if (!aluno) throw new HttpError(404, 'Aluno não encontrado');
    return aluno;
  }

  if (user.role === 'NUTRICIONISTA') {
    if (write) throw new HttpError(403, 'Nutricionista é leitura apenas');
    const nutri = await prisma.nutricionista.findUnique({ where: { userId: user.userId } });
    if (!nutri) throw new HttpError(404, 'Perfil de nutricionista não encontrado');
    const vinculo = await prisma.vinculoNutricionista.findUnique({
      where: { alunoId_nutricionistaId: { alunoId, nutricionistaId: nutri.id } },
    });
    if (!vinculo || !vinculo.aceitoPeloAluno) throw new HttpError(403, 'Aluno não compartilhou rotina');
    const aluno = await prisma.aluno.findUnique({ where: { id: alunoId } });
    if (!aluno) throw new HttpError(404, 'Aluno não encontrado');
    return aluno;
  }

  throw new HttpError(403, 'Acesso negado');
}

export async function listTreinosByAluno({ user, alunoId, filters }) {
  const aluno = await resolveAlunoAccess({ user, alunoId });
  const where = { alunoId: aluno.id };
  if (filters.status) where.status = filters.status;
  if (filters.desde || filters.ate) {
    where.dataAlvo = {};
    if (filters.desde) where.dataAlvo.gte = new Date(filters.desde);
    if (filters.ate) where.dataAlvo.lte = new Date(filters.ate);
  }
  return prisma.treino.findMany({
    where,
    orderBy: { dataAlvo: 'asc' },
    take: filters.limit ?? 50,
  });
}

export async function getTreinoById({ user, treinoId }) {
  const treino = await prisma.treino.findUnique({ where: { id: treinoId } });
  if (!treino) throw new HttpError(404, 'Treino não encontrado');
  await resolveAlunoAccess({ user, alunoId: treino.alunoId });
  return treino;
}

export async function prescreverTreino({ user, input }) {
  if (user.role !== 'PROFESSOR') throw new HttpError(403, 'Apenas professores prescrevem');
  const prof = await prisma.professor.findUnique({ where: { userId: user.userId } });
  if (!prof) throw new HttpError(404, 'Perfil de professor não encontrado');

  await resolveAlunoAccess({ user, alunoId: input.alunoId, write: true });

  return prisma.treino.create({
    data: {
      alunoId: input.alunoId,
      professorId: prof.id,
      modalidade: input.modalidade,
      titulo: input.titulo,
      dataAlvo: new Date(input.dataAlvo),
      detalhes: input.detalhes,
      status: 'PENDENTE',
    },
  });
}

export async function deleteTreino({ user, treinoId }) {
  const treino = await prisma.treino.findUnique({ where: { id: treinoId } });
  if (!treino) throw new HttpError(404, 'Treino não encontrado');
  if (user.role !== 'PROFESSOR') throw new HttpError(403, 'Apenas professores podem cancelar');
  await resolveAlunoAccess({ user, alunoId: treino.alunoId, write: true });
  await prisma.treino.delete({ where: { id: treinoId } });
  return { ok: true };
}
