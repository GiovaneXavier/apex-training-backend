import { prisma } from '../lib/prisma.js';
import { HttpError } from '../middleware/errorHandler.js';

async function getProfessor(userId) {
  const prof = await prisma.professor.findUnique({ where: { userId } });
  if (!prof) throw new HttpError(404, 'Perfil de professor não encontrado');
  return prof;
}

export async function listAlunosVinculados(userId) {
  const prof = await getProfessor(userId);
  const vinculos = await prisma.vinculoProfessor.findMany({
    where: { professorId: prof.id },
    orderBy: { criadoEm: 'desc' },
    include: {
      aluno: {
        include: { user: { select: { id: true, nome: true, email: true, avatarUrl: true } } },
      },
    },
  });

  // Para cada aluno, contagem de treinos pendentes + último concluído
  const alunoIds = vinculos.map((v) => v.alunoId);
  const pendentesPorAluno = await prisma.treino.groupBy({
    by: ['alunoId'],
    where: { alunoId: { in: alunoIds }, status: 'PENDENTE' },
    _count: { _all: true },
  });
  const pendMap = new Map(pendentesPorAluno.map((p) => [p.alunoId, p._count._all]));

  return vinculos.map((v) => ({
    vinculoId: v.id,
    alunoId: v.aluno.id,
    nome: v.aluno.user.nome,
    email: v.aluno.user.email,
    avatarUrl: v.aluno.user.avatarUrl,
    desde: v.criadoEm,
    treinosPendentes: pendMap.get(v.aluno.id) ?? 0,
  }));
}

export async function vincularPorEmail(userId, email) {
  const prof = await getProfessor(userId);
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
  if (!user) throw new HttpError(404, 'Aluno não encontrado com esse email');
  if (user.role !== 'ALUNO') throw new HttpError(400, 'Email pertence a outro tipo de perfil');

  const aluno = await prisma.aluno.findUnique({ where: { userId: user.id } });
  if (!aluno) throw new HttpError(404, 'Perfil de aluno não encontrado');

  const existing = await prisma.vinculoProfessor.findUnique({
    where: { alunoId_professorId: { alunoId: aluno.id, professorId: prof.id } },
  });
  if (existing) throw new HttpError(409, 'Aluno já vinculado');

  const vinculo = await prisma.vinculoProfessor.create({
    data: { alunoId: aluno.id, professorId: prof.id },
  });

  return {
    vinculoId: vinculo.id,
    alunoId: aluno.id,
    nome: user.nome,
    email: user.email,
    desde: vinculo.criadoEm,
    treinosPendentes: 0,
  };
}

export async function desvincular(userId, vinculoId) {
  const prof = await getProfessor(userId);
  const v = await prisma.vinculoProfessor.findUnique({ where: { id: vinculoId } });
  if (!v) throw new HttpError(404, 'Vínculo não encontrado');
  if (v.professorId !== prof.id) throw new HttpError(403, 'Vínculo de outro professor');
  await prisma.vinculoProfessor.delete({ where: { id: vinculoId } });
  return { ok: true };
}

export async function detalheAluno(userId, alunoId) {
  const prof = await getProfessor(userId);
  const v = await prisma.vinculoProfessor.findUnique({
    where: { alunoId_professorId: { alunoId, professorId: prof.id } },
  });
  if (!v) throw new HttpError(403, 'Aluno não vinculado');

  const aluno = await prisma.aluno.findUnique({
    where: { id: alunoId },
    include: { user: { select: { id: true, nome: true, email: true, avatarUrl: true } } },
  });
  if (!aluno) throw new HttpError(404, 'Aluno não encontrado');

  const [pendentes, concluidos, proximaProva, ultimosRPs] = await Promise.all([
    prisma.treino.findMany({
      where: { alunoId, status: 'PENDENTE' },
      orderBy: { dataAlvo: 'asc' },
      take: 10,
    }),
    prisma.treino.findMany({
      where: { alunoId, status: 'CONCLUIDO' },
      orderBy: { finalizadoEm: 'desc' },
      take: 5,
    }),
    prisma.prova.findFirst({
      where: { alunoId, data: { gte: new Date() } },
      orderBy: { data: 'asc' },
    }),
    prisma.recordePessoal.findMany({
      where: { alunoId },
      orderBy: { dataRecorde: 'desc' },
      take: 5,
    }),
  ]);

  return {
    aluno: {
      id: aluno.id,
      nome: aluno.user.nome,
      email: aluno.user.email,
      avatarUrl: aluno.user.avatarUrl,
      pesoKg: aluno.pesoKg,
      alturaCm: aluno.alturaCm,
      dataNascimento: aluno.dataNascimento,
    },
    treinosPendentes: pendentes,
    treinosConcluidos: concluidos,
    proximaProva,
    recordesRecentes: ultimosRPs,
  };
}

// Calendário do professor — todos treinos prescritos pelos alunos vinculados no período.
// Retorna lista flat de treinos com aluno embutido (nome) para o frontend agrupar por dia.
export async function listCalendarioAlunos(userId, { desde, ate }) {
  const prof = await getProfessor(userId);
  const vinculos = await prisma.vinculoProfessor.findMany({
    where: { professorId: prof.id },
    select: { alunoId: true },
  });
  const alunoIds = vinculos.map((v) => v.alunoId);
  if (alunoIds.length === 0) return { treinos: [], provas: [] };

  const desdeDate = new Date(desde);
  const ateDate = new Date(ate);

  const [treinos, provas] = await Promise.all([
    prisma.treino.findMany({
      where: {
        alunoId: { in: alunoIds },
        dataAlvo: { gte: desdeDate, lt: ateDate },
      },
      orderBy: { dataAlvo: 'asc' },
      include: {
        aluno: { include: { user: { select: { nome: true } } } },
      },
    }),
    prisma.prova.findMany({
      where: {
        alunoId: { in: alunoIds },
        data: { gte: desdeDate, lt: ateDate },
      },
      orderBy: { data: 'asc' },
      include: {
        aluno: { include: { user: { select: { nome: true } } } },
      },
    }),
  ]);

  return {
    treinos: treinos.map((t) => ({
      id: t.id,
      alunoId: t.alunoId,
      alunoNome: t.aluno.user.nome,
      modalidade: t.modalidade,
      titulo: t.titulo,
      status: t.status,
      dataAlvo: t.dataAlvo,
    })),
    provas: provas.map((p) => ({
      id: p.id,
      alunoId: p.alunoId,
      alunoNome: p.aluno.user.nome,
      modalidade: p.modalidade,
      nome: p.nome,
      data: p.data,
    })),
  };
}

export async function dashboardProfessor(userId) {
  const prof = await getProfessor(userId);

  const vinculos = await prisma.vinculoProfessor.findMany({
    where: { professorId: prof.id },
    select: { alunoId: true },
  });
  const alunoIds = vinculos.map((v) => v.alunoId);

  const inicioSemana = new Date();
  inicioSemana.setHours(0, 0, 0, 0);
  inicioSemana.setDate(inicioSemana.getDate() - inicioSemana.getDay());
  const fimSemana = new Date(inicioSemana);
  fimSemana.setDate(fimSemana.getDate() + 7);

  const [totalAlunos, pendentesSemana, concluidosSemana, treinosPrescritos] = await Promise.all([
    Promise.resolve(alunoIds.length),
    prisma.treino.count({
      where: { alunoId: { in: alunoIds }, status: 'PENDENTE', dataAlvo: { gte: inicioSemana, lt: fimSemana } },
    }),
    prisma.treino.count({
      where: { alunoId: { in: alunoIds }, status: 'CONCLUIDO', finalizadoEm: { gte: inicioSemana, lt: fimSemana } },
    }),
    prisma.treino.count({ where: { professorId: prof.id } }),
  ]);

  return {
    totalAlunos,
    pendentesSemana,
    concluidosSemana,
    treinosPrescritos,
  };
}
