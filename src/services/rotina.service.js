import { prisma } from '../lib/prisma.js';
import { HttpError } from '../middleware/errorHandler.js';

const DIAS_INDEX = { DOM: 0, SEG: 1, TER: 2, QUA: 3, QUI: 4, SEX: 5, SAB: 6 };
const INDEX_TO_DIA = ['DOM', 'SEG', 'TER', 'QUA', 'QUI', 'SEX', 'SAB'];

async function getProfessor(userId) {
  const prof = await prisma.professor.findUnique({ where: { userId } });
  if (!prof) throw new HttpError(403, 'Apenas professores podem operar rotinas');
  return prof;
}

async function ensureVinculo(professorId, alunoId) {
  const v = await prisma.vinculoProfessor.findUnique({
    where: { alunoId_professorId: { alunoId, professorId } },
  });
  if (!v) throw new HttpError(403, 'Aluno não vinculado a este professor');
}

// ──────────────────────────────────────────────────────────────
// CRUD de rotinas
// ──────────────────────────────────────────────────────────────
export async function listRotinas({ alunoId, diaSemana, ativasEm }) {
  const where = {};
  if (alunoId) where.alunoId = alunoId;
  if (diaSemana) where.diaSemana = diaSemana;
  if (ativasEm) {
    const data = new Date(ativasEm);
    where.vigenciaInicio = { lte: data };
    where.OR = [{ vigenciaFim: null }, { vigenciaFim: { gte: data } }];
  }

  return prisma.rotinaMusculacao.findMany({
    where,
    orderBy: [{ diaSemana: 'asc' }, { criadoEm: 'desc' }],
    include: {
      exercicios: {
        orderBy: { ordem: 'asc' },
        include: { exercicio: true },
      },
    },
  });
}

export async function getRotina(id) {
  const r = await prisma.rotinaMusculacao.findUnique({
    where: { id },
    include: {
      exercicios: { orderBy: { ordem: 'asc' }, include: { exercicio: true } },
      aluno: { include: { user: { select: { nome: true } } } },
    },
  });
  if (!r) throw new HttpError(404, 'Rotina não encontrada');
  return r;
}

export async function createRotina(userId, data) {
  const prof = await getProfessor(userId);
  await ensureVinculo(prof.id, data.alunoId);

  // Sugestão: 3 meses máximo. Se vigenciaFim ausente, alerta apenas (não bloqueia).
  return prisma.rotinaMusculacao.create({
    data: {
      alunoId: data.alunoId,
      professorId: prof.id,
      nome: data.nome,
      diaSemana: data.diaSemana,
      vigenciaInicio: new Date(data.vigenciaInicio),
      vigenciaFim: data.vigenciaFim ? new Date(data.vigenciaFim) : null,
      exercicios: {
        create: data.exercicios.map((e) => ({
          exercicioId: e.exercicioId,
          ordem: e.ordem,
          series: e.series,
          reps: e.reps,
          repsMin: e.repsMin,
          repsMax: e.repsMax,
          cargaPctRP: e.cargaPctRP,
          cargaKg: e.cargaKg,
          descansoSeg: e.descansoSeg,
          observacao: e.observacao,
        })),
      },
    },
    include: { exercicios: { orderBy: { ordem: 'asc' }, include: { exercicio: true } } },
  });
}

export async function updateRotina(userId, id, data) {
  const prof = await getProfessor(userId);
  const r = await prisma.rotinaMusculacao.findUnique({ where: { id } });
  if (!r) throw new HttpError(404, 'Rotina não encontrada');
  if (r.professorId !== prof.id) throw new HttpError(403, 'Você não é dono desta rotina');

  return prisma.$transaction(async (tx) => {
    if (data.exercicios) {
      // Substitui lista — apaga e recria. Treinos já gerados não são afetados.
      await tx.rotinaExercicio.deleteMany({ where: { rotinaId: id } });
    }
    return tx.rotinaMusculacao.update({
      where: { id },
      data: {
        nome: data.nome,
        diaSemana: data.diaSemana,
        vigenciaInicio: data.vigenciaInicio ? new Date(data.vigenciaInicio) : undefined,
        vigenciaFim: data.vigenciaFim === undefined ? undefined : data.vigenciaFim ? new Date(data.vigenciaFim) : null,
        ...(data.exercicios && {
          exercicios: {
            create: data.exercicios.map((e) => ({
              exercicioId: e.exercicioId,
              ordem: e.ordem,
              series: e.series,
              reps: e.reps,
              repsMin: e.repsMin,
              repsMax: e.repsMax,
              cargaPctRP: e.cargaPctRP,
              cargaKg: e.cargaKg,
              descansoSeg: e.descansoSeg,
              observacao: e.observacao,
            })),
          },
        }),
      },
      include: { exercicios: { orderBy: { ordem: 'asc' }, include: { exercicio: true } } },
    });
  });
}

export async function deleteRotina(userId, id) {
  const prof = await getProfessor(userId);
  const r = await prisma.rotinaMusculacao.findUnique({ where: { id } });
  if (!r) throw new HttpError(404, 'Rotina não encontrada');
  if (r.professorId !== prof.id) throw new HttpError(403, 'Você não é dono desta rotina');

  // Cascata: remove rotina + treinos PENDENTES gerados a partir dela.
  // Treinos CONCLUIDO/EM_EXECUCAO ficam, mas com rotinaId virando null (SetNull).
  await prisma.$transaction(async (tx) => {
    await tx.treino.deleteMany({
      where: { rotinaId: id, status: 'PENDENTE' },
    });
    await tx.rotinaMusculacao.delete({ where: { id } });
  });

  return { ok: true };
}

// ──────────────────────────────────────────────────────────────
// "Treino de hoje" — rotinas vigentes do aluno hoje
// ──────────────────────────────────────────────────────────────
export async function rotinasDoDia(alunoId, dataRef = new Date()) {
  const dia = INDEX_TO_DIA[dataRef.getDay()];
  return prisma.rotinaMusculacao.findMany({
    where: {
      alunoId,
      diaSemana: dia,
      vigenciaInicio: { lte: dataRef },
      OR: [{ vigenciaFim: null }, { vigenciaFim: { gte: dataRef } }],
    },
    include: {
      exercicios: { orderBy: { ordem: 'asc' }, include: { exercicio: true } },
    },
    orderBy: { criadoEm: 'asc' },
  });
}

// ──────────────────────────────────────────────────────────────
// Iniciar treino a partir de uma rotina — gera instância de Treino
// snapshotando os exercícios no campo `detalhes` (JSON).
// ──────────────────────────────────────────────────────────────
export async function iniciarTreinoDeRotina(userId, rotinaId, dataAlvo) {
  const aluno = await prisma.aluno.findUnique({ where: { userId } });
  if (!aluno) throw new HttpError(403, 'Apenas alunos podem iniciar treinos');

  const rotina = await prisma.rotinaMusculacao.findUnique({
    where: { id: rotinaId },
    include: { exercicios: { orderBy: { ordem: 'asc' }, include: { exercicio: true } } },
  });
  if (!rotina) throw new HttpError(404, 'Rotina não encontrada');
  if (rotina.alunoId !== aluno.id) throw new HttpError(403, 'Esta rotina não é sua');

  // Reaproveita instância pendente do mesmo dia se já existir
  const dia = dataAlvo ? new Date(dataAlvo) : new Date();
  const inicio = new Date(dia); inicio.setHours(0, 0, 0, 0);
  const fim = new Date(dia); fim.setHours(23, 59, 59, 999);

  const existente = await prisma.treino.findFirst({
    where: {
      rotinaId, alunoId: aluno.id,
      dataAlvo: { gte: inicio, lte: fim },
      status: { in: ['PENDENTE', 'EM_EXECUCAO'] },
    },
  });
  if (existente) return existente;

  const detalhes = {
    tipo: 'musculacao',
    rotinaId,
    exercicios: rotina.exercicios.map((re) => ({
      nome: re.exercicio.nome,
      videoUrl: re.exercicio.videoUrl ?? undefined,
      prescrito: {
        series: re.series,
        reps: re.reps ?? undefined,
        repsMin: re.repsMin ?? undefined,
        repsMax: re.repsMax ?? undefined,
        cargaPctRP: re.cargaPctRP ?? undefined,
        cargaKg: re.cargaKg ?? undefined,
        descansoSeg: re.descansoSeg ?? undefined,
        observacao: re.observacao ?? undefined,
      },
      realizado: [],
    })),
  };

  return prisma.treino.create({
    data: {
      alunoId: aluno.id,
      professorId: rotina.professorId,
      rotinaId,
      modalidade: 'MUSCULACAO',
      titulo: rotina.nome,
      dataAlvo: dia,
      status: 'PENDENTE',
      detalhes,
    },
  });
}

// ──────────────────────────────────────────────────────────────
// Reagendar treino — aluno move dataAlvo
// ──────────────────────────────────────────────────────────────
export async function reagendarTreino(userId, treinoId, novaDataAlvo) {
  const aluno = await prisma.aluno.findUnique({ where: { userId } });
  if (!aluno) throw new HttpError(403, 'Apenas alunos podem reagendar');

  const t = await prisma.treino.findUnique({ where: { id: treinoId } });
  if (!t) throw new HttpError(404, 'Treino não encontrado');
  if (t.alunoId !== aluno.id) throw new HttpError(403, 'Treino não é seu');
  if (t.status === 'CONCLUIDO' || t.status === 'PULADO') {
    throw new HttpError(400, 'Treino já finalizado não pode ser reagendado');
  }

  return prisma.treino.update({
    where: { id: treinoId },
    data: {
      dataAlvo: new Date(novaDataAlvo),
      reagendadoDe: t.reagendadoDe ?? t.dataAlvo, // preserva primeira data original
    },
  });
}

export { DIAS_INDEX, INDEX_TO_DIA };
