import { prisma } from '../lib/prisma.js';
import { resolveAlunoAccess } from '../lib/access.js';
import { HttpError } from '../middleware/errorHandler.js';

const DIAS_INDEX = { DOM: 0, SEG: 1, TER: 2, QUA: 3, QUI: 4, SEX: 5, SAB: 6 };
const INDEX_TO_DIA = ['DOM', 'SEG', 'TER', 'QUA', 'QUI', 'SEX', 'SAB'];

// ─────────────────────────────────────────────────────────────────────
// REGRA DE OURO desta sprint:
// Toda função pública que retorna ou modifica dados de um aluno chama
// resolveAlunoAccess({ user, alunoId, write? }) ANTES de tocar o DB.
// Não há exceção. Função sem `user` → bug.
// ─────────────────────────────────────────────────────────────────────

async function getProfessor(userId) {
  const prof = await prisma.professor.findUnique({ where: { userId } });
  if (!prof) throw new HttpError(403, 'Apenas professores podem operar rotinas');
  return prof;
}

// ──────────────────────────────────────────────────────────────
// LEITURAS — todas passam pelo guardião antes de qualquer query.
// ──────────────────────────────────────────────────────────────

export async function listRotinas({ user, alunoId, diaSemana, ativasEm }) {
  // Guarda ACL: ALUNO só o próprio, PROFESSOR/NUTRI com vínculo
  // (nutri exige aceitoPeloAluno=true via resolveAlunoAccess).
  const aluno = await resolveAlunoAccess({ user, alunoId });

  const where = { alunoId: aluno.id };
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

export async function getRotina({ user, id }) {
  // Carrega só o que precisamos pra autorizar — sem hidratar exercícios
  // antes da checagem (evita gastar query custosa em request não-autorizada).
  const meta = await prisma.rotinaMusculacao.findUnique({
    where: { id },
    select: { id: true, alunoId: true },
  });
  if (!meta) throw new HttpError(404, 'Rotina não encontrada');

  await resolveAlunoAccess({ user, alunoId: meta.alunoId });

  return prisma.rotinaMusculacao.findUnique({
    where: { id },
    include: {
      exercicios: { orderBy: { ordem: 'asc' }, include: { exercicio: true } },
      aluno: { include: { user: { select: { nome: true } } } },
    },
  });
}

// "Treino de hoje" — rotinas vigentes do aluno hoje.
// Agora exige guardião: antes era acessível por qualquer autenticado.
export async function rotinasDoDia({ user, alunoId, dataRef = new Date() }) {
  const aluno = await resolveAlunoAccess({ user, alunoId });
  const dia = INDEX_TO_DIA[dataRef.getDay()];
  return prisma.rotinaMusculacao.findMany({
    where: {
      alunoId: aluno.id,
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
// MUTAÇÕES — write=true no guardião. NUTRI sempre 403 aqui.
// ──────────────────────────────────────────────────────────────

export async function createRotina(userId, data) {
  const user = { role: 'PROFESSOR', userId };
  // Rota já exige role=PROFESSOR; aqui validamos vínculo via guardião.
  await resolveAlunoAccess({ user, alunoId: data.alunoId, write: true });
  const prof = await getProfessor(userId);

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
  const r = await prisma.rotinaMusculacao.findUnique({
    where: { id },
    select: { id: true, alunoId: true, professorId: true },
  });
  if (!r) throw new HttpError(404, 'Rotina não encontrada');

  // Guardião valida vínculo professor↔aluno. Ownership da rotina é checado
  // separado: professor X não pode editar rotina prescrita por professor Y
  // pro mesmo aluno mesmo tendo vínculo.
  const user = { role: 'PROFESSOR', userId };
  await resolveAlunoAccess({ user, alunoId: r.alunoId, write: true });
  const prof = await getProfessor(userId);
  if (r.professorId !== prof.id) throw new HttpError(403, 'Você não é dono desta rotina');

  return prisma.$transaction(async (tx) => {
    if (data.exercicios) {
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
  const r = await prisma.rotinaMusculacao.findUnique({
    where: { id },
    select: { id: true, alunoId: true, professorId: true },
  });
  if (!r) throw new HttpError(404, 'Rotina não encontrada');

  const user = { role: 'PROFESSOR', userId };
  await resolveAlunoAccess({ user, alunoId: r.alunoId, write: true });
  const prof = await getProfessor(userId);
  if (r.professorId !== prof.id) throw new HttpError(403, 'Você não é dono desta rotina');

  // Cascata: remove rotina + treinos PENDENTES gerados a partir dela.
  await prisma.$transaction(async (tx) => {
    await tx.treino.deleteMany({
      where: { rotinaId: id, status: 'PENDENTE' },
    });
    await tx.rotinaMusculacao.delete({ where: { id } });
  });

  return { ok: true };
}

// ──────────────────────────────────────────────────────────────
// Iniciar treino a partir de uma rotina — ALUNO only.
// O guardião confirma que `rotina.alunoId` é o aluno corrente.
// ──────────────────────────────────────────────────────────────
export async function iniciarTreinoDeRotina(userId, rotinaId, dataAlvo) {
  const user = { role: 'ALUNO', userId };
  // Acesso "global" do aluno (sem alunoId) — só pra confirmar perfil existe.
  const aluno = await resolveAlunoAccess({ user });

  const rotina = await prisma.rotinaMusculacao.findUnique({
    where: { id: rotinaId },
    include: { exercicios: { orderBy: { ordem: 'asc' }, include: { exercicio: true } } },
  });
  if (!rotina) throw new HttpError(404, 'Rotina não encontrada');
  // Re-checa ownership do aluno sobre a rotina.
  if (rotina.alunoId !== aluno.id) throw new HttpError(403, 'Esta rotina não é sua');

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
// Reagendar treino — ALUNO only.
// ──────────────────────────────────────────────────────────────
export async function reagendarTreino(userId, treinoId, novaDataAlvo) {
  const user = { role: 'ALUNO', userId };
  const aluno = await resolveAlunoAccess({ user });

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
      reagendadoDe: t.reagendadoDe ?? t.dataAlvo,
    },
  });
}

export { DIAS_INDEX, INDEX_TO_DIA };
