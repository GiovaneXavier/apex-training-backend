import { prisma } from '../lib/prisma.js';
import { HttpError } from '../middleware/errorHandler.js';
import { calcularIMC, calcularPercentualGordura } from '../lib/bodyfat.js';

// ──────────────────────────────────────────────────────────────
// Helpers de acesso
// ──────────────────────────────────────────────────────────────
async function resolveAlunoAccess({ user, alunoId, write = false }) {
  if (user.role === 'ALUNO') {
    const aluno = await prisma.aluno.findUnique({ where: { userId: user.userId } });
    if (!aluno) throw new HttpError(404, 'Perfil de aluno não encontrado');
    if (alunoId && alunoId !== aluno.id) throw new HttpError(403, 'Acesso negado');
    return { aluno, avaliadorTipo: 'ALUNO' };
  }
  if (!alunoId) throw new HttpError(400, 'alunoId obrigatório');

  if (user.role === 'PROFESSOR') {
    const prof = await prisma.professor.findUnique({ where: { userId: user.userId } });
    if (!prof) throw new HttpError(404, 'Professor não encontrado');
    const v = await prisma.vinculoProfessor.findUnique({
      where: { alunoId_professorId: { alunoId, professorId: prof.id } },
    });
    if (!v) throw new HttpError(403, 'Aluno não vinculado');
    const aluno = await prisma.aluno.findUnique({ where: { id: alunoId } });
    if (!aluno) throw new HttpError(404, 'Aluno não encontrado');
    return { aluno, avaliadorTipo: 'PROFESSOR' };
  }

  if (user.role === 'NUTRICIONISTA') {
    const nutri = await prisma.nutricionista.findUnique({ where: { userId: user.userId } });
    if (!nutri) throw new HttpError(404, 'Nutricionista não encontrado');
    const v = await prisma.vinculoNutricionista.findUnique({
      where: { alunoId_nutricionistaId: { alunoId, nutricionistaId: nutri.id } },
    });
    if (!v) throw new HttpError(403, 'Aluno não vinculado');
    if (!v.aceitoPeloAluno && write) throw new HttpError(403, 'Aluno ainda não aceitou o vínculo');
    const aluno = await prisma.aluno.findUnique({ where: { id: alunoId } });
    if (!aluno) throw new HttpError(404, 'Aluno não encontrado');
    return { aluno, avaliadorTipo: 'NUTRICIONISTA' };
  }

  throw new HttpError(403, 'Acesso negado');
}

// Para cálculo de %BF: deriva idade da dataNascimento do Aluno se não vier no body.
function deriveIdade(aluno, idadeAnos) {
  if (idadeAnos) return idadeAnos;
  if (!aluno.dataNascimento) return undefined;
  const dn = new Date(aluno.dataNascimento);
  const diff = Date.now() - dn.getTime();
  return Math.floor(diff / (1000 * 60 * 60 * 24 * 365.25));
}

// ──────────────────────────────────────────────────────────────
// CRUD
// ──────────────────────────────────────────────────────────────
export async function listEvolucoes({ user, filters }) {
  const { aluno } = await resolveAlunoAccess({ user, alunoId: filters.alunoId });
  const where = { alunoId: aluno.id };
  if (filters.desde || filters.ate) {
    where.dataAvaliacao = {};
    if (filters.desde) where.dataAvaliacao.gte = new Date(filters.desde);
    if (filters.ate) where.dataAvaliacao.lte = new Date(filters.ate);
  }
  return prisma.evolucaoCorporal.findMany({
    where,
    orderBy: { dataAvaliacao: 'desc' },
    take: filters.limit ?? 100,
  });
}

export async function getEvolucao({ user, id }) {
  const ev = await prisma.evolucaoCorporal.findUnique({ where: { id } });
  if (!ev) throw new HttpError(404, 'Avaliação não encontrada');
  await resolveAlunoAccess({ user, alunoId: ev.alunoId });
  return ev;
}

export async function createEvolucao({ user, input }) {
  const { aluno, avaliadorTipo } = await resolveAlunoAccess({
    user, alunoId: input.alunoId, write: true,
  });

  const idade = deriveIdade(aluno, input.idadeAnos);
  const sexo = input.sexoBio;

  const imc = calcularIMC({ pesoKg: input.pesoKg, alturaCm: input.alturaCm });
  const percentualGordura = calcularPercentualGordura({
    protocolo: input.protocolo,
    medidas: input.medidas,
    sexo, idade,
  });

  return prisma.evolucaoCorporal.create({
    data: {
      alunoId: aluno.id,
      avaliadorId: user.userId,
      avaliadorTipo,
      dataAvaliacao: input.dataAvaliacao ? new Date(input.dataAvaliacao) : new Date(),
      pesoKg: input.pesoKg ?? null,
      alturaCm: input.alturaCm ?? null,
      imc,
      percentualGordura,
      protocolo: input.protocolo ?? null,
      medidas: input.medidas ?? null,
      fotos: input.fotos ?? null,
      observacoes: input.observacoes ?? null,
    },
  });
}

export async function updateEvolucao({ user, id, input }) {
  const ev = await prisma.evolucaoCorporal.findUnique({ where: { id } });
  if (!ev) throw new HttpError(404, 'Avaliação não encontrada');

  const { aluno, avaliadorTipo } = await resolveAlunoAccess({
    user, alunoId: ev.alunoId, write: true,
  });

  // Aluno só edita avaliação que ele mesmo registrou.
  if (avaliadorTipo === 'ALUNO' && ev.avaliadorTipo !== 'ALUNO') {
    throw new HttpError(403, 'Aluno não pode editar avaliação profissional');
  }

  const merged = {
    pesoKg: input.pesoKg ?? ev.pesoKg,
    alturaCm: input.alturaCm ?? ev.alturaCm,
    protocolo: input.protocolo ?? ev.protocolo,
    medidas: input.medidas ?? ev.medidas,
    fotos: input.fotos ?? ev.fotos,
    observacoes: input.observacoes ?? ev.observacoes,
  };

  const idade = deriveIdade(aluno, input.idadeAnos);
  const imc = calcularIMC({ pesoKg: merged.pesoKg, alturaCm: merged.alturaCm });
  const percentualGordura = calcularPercentualGordura({
    protocolo: merged.protocolo,
    medidas: merged.medidas,
    sexo: input.sexoBio,
    idade,
  });

  return prisma.evolucaoCorporal.update({
    where: { id },
    data: {
      ...merged,
      dataAvaliacao: input.dataAvaliacao ? new Date(input.dataAvaliacao) : ev.dataAvaliacao,
      imc,
      percentualGordura,
    },
  });
}

export async function deleteEvolucao({ user, id }) {
  const ev = await prisma.evolucaoCorporal.findUnique({ where: { id } });
  if (!ev) throw new HttpError(404, 'Avaliação não encontrada');
  const { avaliadorTipo } = await resolveAlunoAccess({ user, alunoId: ev.alunoId, write: true });
  if (avaliadorTipo === 'ALUNO' && ev.avaliadorTipo !== 'ALUNO') {
    throw new HttpError(403, 'Aluno não pode excluir avaliação profissional');
  }
  await prisma.evolucaoCorporal.delete({ where: { id } });
  return { ok: true };
}

// Endpoint utilitário: pré-visualizar cálculo de %BF sem persistir.
// Útil para o frontend mostrar resultado em tempo real antes de salvar.
export async function previewBodyFat({ protocolo, medidas, sexoBio, idadeAnos, pesoKg, alturaCm }) {
  const imc = calcularIMC({ pesoKg, alturaCm });
  const percentualGordura = calcularPercentualGordura({
    protocolo, medidas, sexo: sexoBio, idade: idadeAnos,
  });
  return { imc, percentualGordura };
}
