import { prisma } from '../lib/prisma.js';
import { resolveAlunoAccess } from '../lib/access.js';
import { HttpError } from '../middleware/errorHandler.js';
import { calcularIMC, calcularPercentualGordura } from '../lib/bodyfat.js';

// ──────────────────────────────────────────────────────────────
// Helpers de acesso
//
// Evolução Corporal é o ÚNICO módulo onde o nutricionista tem domínio
// legítimo de escrita (ISAK profissional). Aqui passamos
// `allowNutriWrite: true` no guardião canônico. Continua sendo necessário
// `vinculo.aceitoPeloAluno === true` — a flag só destrava a escrita,
// não bypassa o aceite.
//
// BUG corrigido no PR #4.1: a cópia local antiga permitia LEITURA por
// nutri sem aceite. Agora o guardião exige aceite para qualquer acesso.
// ──────────────────────────────────────────────────────────────

// Role do JWT → enum AvaliadorTipo (Prisma). Strings idênticas.
function avaliadorTipoFromRole(role) {
  return role; // ALUNO | PROFESSOR | NUTRICIONISTA
}

async function resolveAcessoEvolucao({ user, alunoId, write = false }) {
  const aluno = await resolveAlunoAccess({
    user,
    alunoId,
    write,
    allowNutriWrite: true, // único módulo onde NUTRI escreve legitimamente
  });
  return { aluno, avaliadorTipo: avaliadorTipoFromRole(user.role) };
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
  const { aluno } = await resolveAcessoEvolucao({ user, alunoId: filters.alunoId });
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
  await resolveAcessoEvolucao({ user, alunoId: ev.alunoId });
  return ev;
}

export async function createEvolucao({ user, input }) {
  const { aluno, avaliadorTipo } = await resolveAcessoEvolucao({
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

  const { aluno, avaliadorTipo } = await resolveAcessoEvolucao({
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
  const { avaliadorTipo } = await resolveAcessoEvolucao({ user, alunoId: ev.alunoId, write: true });
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
