import { prisma } from '../lib/prisma.js';
import { HttpError } from '../middleware/errorHandler.js';
import { inicioSemana, fimSemana } from '../lib/dates.js';

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

// PR #14 (audit 2.21) — anti-enumeration.
//
// Esta rota é o vetor clássico de enumeration: profissional manda email,
// resposta 404/409/200 vaza se o email existe e qual papel tem. Atacante
// vira lista de emails do app em minutos.
//
// Fix: a função SEMPRE retorna `{ ok: true }` sem revelar nada. Internamente:
//   - Email não existe → no-op.
//   - Email existe mas não é ALUNO → no-op.
//   - Email é aluno e ainda não vinculado → cria o vínculo.
//   - Email é aluno e já vinculado → no-op (idempotente).
//
// A única exceção que ainda lançamos é "professor sem perfil" — não é
// enumeration de aluno, é auth real do chamador.
//
// O profissional vê o resultado real refrescando a lista de alunos.
// É um trade-off de UX: perde o feedback imediato "aluno vinculado!", mas
// fecha o vetor. Convite por notificação push/email pode ser adicionado
// depois, sem reabrir a brecha.
export async function vincularPorEmail(userId, email) {
  const prof = await getProfessor(userId);
  const emailNorm = email.toLowerCase().trim();

  const user = await prisma.user.findUnique({ where: { email: emailNorm } });
  if (!user || user.role !== 'ALUNO') {
    return { ok: true };
  }

  const aluno = await prisma.aluno.findUnique({ where: { userId: user.id } });
  if (!aluno) {
    return { ok: true };
  }

  // Idempotente: tentar criar e ignorar P2002 (race entre dois cliques)
  // ou checar antes (mais simples). Optei por checar antes — não há race
  // significativa neste fluxo (UI desabilita o botão durante o POST).
  const existing = await prisma.vinculoProfessor.findUnique({
    where: { alunoId_professorId: { alunoId: aluno.id, professorId: prof.id } },
  });
  if (existing) {
    return { ok: true };
  }

  await prisma.vinculoProfessor.create({
    data: { alunoId: aluno.id, professorId: prof.id },
  });
  return { ok: true };
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

  // Semana padrão BR (segunda → próxima segunda). Antes do PR #14 esta
  // função usava domingo como início — divergente do frontend e do
  // desempenho.service, fazendo o "pendentesSemana" sair errado.
  const ini = inicioSemana();
  const fim = fimSemana();

  const [totalAlunos, pendentesSemana, concluidosSemana, treinosPrescritos] = await Promise.all([
    Promise.resolve(alunoIds.length),
    prisma.treino.count({
      where: { alunoId: { in: alunoIds }, status: 'PENDENTE', dataAlvo: { gte: ini, lt: fim } },
    }),
    prisma.treino.count({
      where: { alunoId: { in: alunoIds }, status: 'CONCLUIDO', finalizadoEm: { gte: ini, lt: fim } },
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
