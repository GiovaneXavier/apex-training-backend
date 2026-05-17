import { prisma } from '../lib/prisma.js';
import { HttpError } from '../middleware/errorHandler.js';

async function getNutri(userId) {
  const n = await prisma.nutricionista.findUnique({ where: { userId } });
  if (!n) throw new HttpError(404, 'Perfil de nutricionista não encontrado');
  return n;
}

export async function listAlunosVinculados(userId) {
  const nutri = await getNutri(userId);
  const vinculos = await prisma.vinculoNutricionista.findMany({
    where: { nutricionistaId: nutri.id },
    orderBy: { criadoEm: 'desc' },
    include: {
      aluno: { include: { user: { select: { nome: true, email: true, avatarUrl: true } } } },
    },
  });
  return vinculos.map((v) => ({
    vinculoId: v.id,
    alunoId: v.aluno.id,
    nome: v.aluno.user.nome,
    email: v.aluno.user.email,
    avatarUrl: v.aluno.user.avatarUrl,
    aceitoPeloAluno: v.aceitoPeloAluno,
    desde: v.criadoEm,
  }));
}

export async function solicitarVinculoPorEmail(userId, email) {
  const nutri = await getNutri(userId);
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
  if (!user) throw new HttpError(404, 'Aluno não encontrado com esse email');
  if (user.role !== 'ALUNO') throw new HttpError(400, 'Email pertence a outro perfil');

  const aluno = await prisma.aluno.findUnique({ where: { userId: user.id } });
  if (!aluno) throw new HttpError(404, 'Perfil de aluno não encontrado');

  const existing = await prisma.vinculoNutricionista.findUnique({
    where: { alunoId_nutricionistaId: { alunoId: aluno.id, nutricionistaId: nutri.id } },
  });
  if (existing) throw new HttpError(409, 'Solicitação já enviada');

  const vinculo = await prisma.vinculoNutricionista.create({
    data: { alunoId: aluno.id, nutricionistaId: nutri.id, aceitoPeloAluno: false },
  });

  return {
    vinculoId: vinculo.id,
    alunoId: aluno.id,
    nome: user.nome,
    email: user.email,
    aceitoPeloAluno: false,
    desde: vinculo.criadoEm,
  };
}

export async function desvincular(userId, vinculoId) {
  const nutri = await getNutri(userId);
  const v = await prisma.vinculoNutricionista.findUnique({ where: { id: vinculoId } });
  if (!v) throw new HttpError(404, 'Vínculo não encontrado');
  if (v.nutricionistaId !== nutri.id) throw new HttpError(403, 'Vínculo de outro nutri');
  await prisma.vinculoNutricionista.delete({ where: { id: vinculoId } });
  return { ok: true };
}

export async function detalheAluno(userId, alunoId) {
  const nutri = await getNutri(userId);
  const v = await prisma.vinculoNutricionista.findUnique({
    where: { alunoId_nutricionistaId: { alunoId, nutricionistaId: nutri.id } },
  });
  if (!v) throw new HttpError(403, 'Aluno não vinculado');
  if (!v.aceitoPeloAluno) throw new HttpError(403, 'Aluno ainda não aceitou compartilhamento');

  const aluno = await prisma.aluno.findUnique({
    where: { id: alunoId },
    include: { user: { select: { nome: true, email: true, avatarUrl: true } } },
  });
  if (!aluno) throw new HttpError(404, 'Aluno não encontrado');

  const agora = new Date();
  const em30 = new Date();
  em30.setDate(em30.getDate() + 30);

  const [proximosTreinos, proximasProvas] = await Promise.all([
    prisma.treino.findMany({
      where: { alunoId, dataAlvo: { gte: agora, lte: em30 } },
      orderBy: { dataAlvo: 'asc' },
      take: 30,
    }),
    prisma.prova.findMany({
      where: { alunoId, data: { gte: agora } },
      orderBy: { data: 'asc' },
      take: 10,
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
    },
    // PR #18a — flag explícita pro front gating visual de escrita.
    // Hoje sempre `true` (a rota só passa do guard se o aceite estiver
    // cravado), mas o contrato carrega a flag pra que se o aluno revogar
    // entre fetch e ação, o front possa ler do estado e desabilitar
    // ações em vez de só depender do 403 do backend. Defesa em profundidade.
    aceitoPeloAluno: v.aceitoPeloAluno,
    proximosTreinos,
    proximasProvas,
  };
}
