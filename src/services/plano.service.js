import { prisma } from '../lib/prisma.js';
import { resolveAlunoAccess } from '../lib/access.js';
import { HttpError } from '../middleware/errorHandler.js';

// PR #18b — PlanoAlimentar (PDF + metas).
//
// Acesso:
//   - READ : ALUNO dono + PROFESSOR/NUTRI vinculados (nutri exige aceite).
//   - WRITE: somente NUTRICIONISTA com `aceitoPeloAluno=true`. Espelha o
//            mesmo padrão usado em EvolucaoCorporal (allowNutriWrite=true
//            no guardião). PROFESSOR/ALUNO NÃO escrevem aqui.

async function resolveLeitura({ user, alunoId }) {
  // Leitura segue a ACL canônica do guardião — nutri SEM aceite leva 403.
  return resolveAlunoAccess({ user, alunoId });
}

async function resolveEscrita({ user, alunoId }) {
  if (user.role !== 'NUTRICIONISTA') {
    throw new HttpError(403, 'Apenas nutricionista pode gerenciar plano alimentar');
  }
  // allowNutriWrite=true destrava a escrita; aceite continua obrigatório.
  return resolveAlunoAccess({ user, alunoId, write: true, allowNutriWrite: true });
}

async function getNutri(userId) {
  const nutri = await prisma.nutricionista.findUnique({ where: { userId } });
  if (!nutri) throw new HttpError(404, 'Perfil de nutricionista não encontrado');
  return nutri;
}

export async function listPlanos({ user, filters }) {
  const aluno = await resolveLeitura({ user, alunoId: filters.alunoId });

  const where = { alunoId: aluno.id };
  if (filters.ativo === 'true') where.ativo = true;
  else if (filters.ativo === 'false') where.ativo = false;
  // 'any' → sem filtro

  return prisma.planoAlimentar.findMany({
    where,
    orderBy: [{ ativo: 'desc' }, { criadoEm: 'desc' }],
    take: filters.limit ?? 20,
  });
}

// "Plano vigente" — endpoint quente do aluno (card no dashboard).
// findFirst com (alunoId, ativo=true) usa o índice composto que criamos
// na migration — query barata mesmo com histórico grande.
export async function getPlanoAtual({ user, alunoId }) {
  const aluno = await resolveLeitura({ user, alunoId });
  return prisma.planoAlimentar.findFirst({
    where: { alunoId: aluno.id, ativo: true },
    orderBy: { criadoEm: 'desc' },
  });
}

// Cria novo plano e desativa os anteriores na MESMA transação. Sem isso,
// 2 chamadas concorrentes podiam deixar 2 planos ativos pro mesmo aluno —
// daria ambiguidade no card "plano vigente". $transaction garante
// atomicidade no Postgres.
export async function createPlano({ user, input }) {
  const aluno = await resolveEscrita({ user, alunoId: input.alunoId });
  const nutri = await getNutri(user.userId);

  const [, novo] = await prisma.$transaction([
    prisma.planoAlimentar.updateMany({
      where: { alunoId: aluno.id, ativo: true },
      data: { ativo: false },
    }),
    prisma.planoAlimentar.create({
      data: {
        alunoId: aluno.id,
        nutricionistaId: nutri.id,
        pdfUrl: input.pdfUrl,
        pdfKey: input.pdfKey ?? null,
        metasText: input.metasText ?? null,
        ativo: true,
      },
    }),
  ]);
  return novo;
}

export async function updatePlano({ user, id, input }) {
  const plano = await prisma.planoAlimentar.findUnique({ where: { id } });
  if (!plano) throw new HttpError(404, 'Plano não encontrado');

  await resolveEscrita({ user, alunoId: plano.alunoId });

  // Só o nutri criador pode editar (auditoria). Se o nutri saiu da
  // plataforma (nutricionistaId=null por SetNull), permitimos que
  // qualquer outro nutri vinculado tome posse via update — comportamento
  // pragmático pra não deixar plano "órfão" travado.
  if (plano.nutricionistaId) {
    const nutri = await getNutri(user.userId);
    if (plano.nutricionistaId !== nutri.id) {
      throw new HttpError(403, 'Apenas o nutricionista criador pode editar este plano');
    }
  }

  return prisma.planoAlimentar.update({
    where: { id },
    data: {
      pdfUrl: input.pdfUrl ?? plano.pdfUrl,
      pdfKey: input.pdfKey ?? plano.pdfKey,
      metasText: input.metasText ?? plano.metasText,
    },
  });
}

export async function deletePlano({ user, id }) {
  const plano = await prisma.planoAlimentar.findUnique({ where: { id } });
  if (!plano) throw new HttpError(404, 'Plano não encontrado');

  await resolveEscrita({ user, alunoId: plano.alunoId });

  if (plano.nutricionistaId) {
    const nutri = await getNutri(user.userId);
    if (plano.nutricionistaId !== nutri.id) {
      throw new HttpError(403, 'Apenas o nutricionista criador pode excluir este plano');
    }
  }

  await prisma.planoAlimentar.delete({ where: { id } });
  return { ok: true };
}
