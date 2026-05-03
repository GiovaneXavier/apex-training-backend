import { prisma } from '../lib/prisma.js';
import { HttpError } from '../middleware/errorHandler.js';

async function resolveAlunoForProva({ user, alunoId, write = false }) {
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
    if (!vinculo) throw new HttpError(403, 'Aluno não vinculado');
    const aluno = await prisma.aluno.findUnique({ where: { id: alunoId } });
    if (!aluno) throw new HttpError(404, 'Aluno não encontrado');
    return aluno;
  }

  if (user.role === 'NUTRICIONISTA') {
    if (write) throw new HttpError(403, 'Nutricionista é leitura apenas');
    const nutri = await prisma.nutricionista.findUnique({ where: { userId: user.userId } });
    if (!nutri) throw new HttpError(404, 'Perfil não encontrado');
    const vinculo = await prisma.vinculoNutricionista.findUnique({
      where: { alunoId_nutricionistaId: { alunoId, nutricionistaId: nutri.id } },
    });
    if (!vinculo || !vinculo.aceitoPeloAluno) throw new HttpError(403, 'Sem acesso');
    const aluno = await prisma.aluno.findUnique({ where: { id: alunoId } });
    if (!aluno) throw new HttpError(404, 'Aluno não encontrado');
    return aluno;
  }
  throw new HttpError(403, 'Acesso negado');
}

export async function listProvasByAluno({ user, alunoId, filters }) {
  const aluno = await resolveAlunoForProva({ user, alunoId });
  const where = { alunoId: aluno.id };
  if (filters.desde || filters.ate) {
    where.data = {};
    if (filters.desde) where.data.gte = new Date(filters.desde);
    if (filters.ate) where.data.lte = new Date(filters.ate);
  }
  return prisma.prova.findMany({
    where,
    orderBy: { data: 'asc' },
    take: filters.limit ?? 100,
  });
}

export async function criarProva({ user, input }) {
  // Aluno cria pra si mesmo (alunoId opcional); Professor pode criar pro vinculado
  let alunoId = input.alunoId;
  if (user.role === 'ALUNO') {
    const aluno = await prisma.aluno.findUnique({ where: { userId: user.userId } });
    if (!aluno) throw new HttpError(404, 'Aluno não encontrado');
    alunoId = aluno.id;
  } else if (user.role === 'PROFESSOR') {
    if (!alunoId) throw new HttpError(400, 'alunoId obrigatório para professor');
    await resolveAlunoForProva({ user, alunoId, write: true });
  } else {
    throw new HttpError(403, 'Sem permissão para criar prova');
  }

  return prisma.prova.create({
    data: {
      alunoId,
      modalidade: input.modalidade,
      nome: input.nome,
      data: new Date(input.data),
      detalhes: input.detalhes ?? {},
    },
  });
}

export async function deleteProva({ user, provaId }) {
  const prova = await prisma.prova.findUnique({ where: { id: provaId } });
  if (!prova) throw new HttpError(404, 'Prova não encontrada');
  if (user.role === 'NUTRICIONISTA') throw new HttpError(403, 'Sem permissão');
  await resolveAlunoForProva({ user, alunoId: prova.alunoId, write: true });
  await prisma.prova.delete({ where: { id: provaId } });
  return { ok: true };
}
