import { prisma } from '../lib/prisma.js';
import { HttpError } from '../middleware/errorHandler.js';

// ─────────────────────────────────────────────────────────────────────
// PR #37 (Sprint 14) — Macro-ciclo: Race A/B/C.
//
// Invariante "1 Race A ativa por aluno" é garantida por partial unique
// index no Postgres (`prova_alvo_principal_ativo`, migration
// 20260523000000). Service captura `P2002` do Prisma e converte em
// HTTP 409 com mensagem amigável + ponteiro pro alvo atual.
//
// `arquivada` é estado explícito — atleta/coach arquiva manualmente
// (provas adiadas/canceladas não viram arquivada automaticamente).
// ─────────────────────────────────────────────────────────────────────

const PROVA_ALVO_UNIQUE_INDEX = 'prova_alvo_principal_ativo';

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

  if (user.role === 'ADMIN') {
    if (!alunoId) throw new HttpError(400, 'alunoId obrigatório');
    const aluno = await prisma.aluno.findUnique({ where: { id: alunoId } });
    if (!aluno) throw new HttpError(404, 'Aluno não encontrado');
    return aluno;
  }
  throw new HttpError(403, 'Acesso negado');
}

// Wrapper que converte P2002 do partial unique em 409 com payload útil.
// Mensagem inclui o alvo atual pra o cliente não precisar fazer outra
// query pra descobrir "qual é a Race A que está bloqueando".
async function handleUniqueConflict(alunoId, operation) {
  try {
    return await operation();
  } catch (err) {
    // Detecção via code+meta — não usamos `instanceof Prisma.PrismaClient*`
    // porque polui a interface (forçaria importar @prisma/client em testes
    // e mockar a classe). `code === 'P2002'` é estável entre versões.
    // Em alguns drivers `meta.target` é string, em outros array.
    if (
      err?.code === 'P2002' &&
      String(err?.meta?.target || '').includes(PROVA_ALVO_UNIQUE_INDEX)
    ) {
      const atual = await prisma.prova.findFirst({
        where: { alunoId, prioridade: 'A', arquivada: false },
        select: { id: true, nome: true, data: true },
      });
      throw new HttpError(409, 'Já existe Race A ativa para este aluno', {
        code: 'PROVA_ALVO_DUPLICADO',
        alvoAtual: atual,
      });
    }
    throw err;
  }
}

export async function listProvasByAluno({ user, alunoId, filters }) {
  const aluno = await resolveAlunoForProva({ user, alunoId });
  const where = { alunoId: aluno.id };
  if (!filters.incluirArquivadas) where.arquivada = false;
  if (filters.prioridade) where.prioridade = filters.prioridade;
  if (filters.desde || filters.ate) {
    where.data = {};
    if (filters.desde) where.data.gte = new Date(filters.desde);
    if (filters.ate) where.data.lte = new Date(filters.ate);
  }
  return prisma.prova.findMany({
    where,
    orderBy: [{ prioridade: 'asc' }, { data: 'asc' }],
    take: filters.limit ?? 100,
  });
}

// Endpoint dedicado pro Dashboard do aluno: retorna a Race A ativa
// (ou null) sem precisar paginar a lista. Uso típico: card de countdown.
export async function getProvaAlvo({ user, alunoId }) {
  const aluno = await resolveAlunoForProva({ user, alunoId });
  return prisma.prova.findFirst({
    where: { alunoId: aluno.id, prioridade: 'A', arquivada: false },
  });
}

export async function criarProva({ user, input }) {
  let alunoId = input.alunoId;
  if (user.role === 'ALUNO') {
    const aluno = await prisma.aluno.findUnique({ where: { userId: user.userId } });
    if (!aluno) throw new HttpError(404, 'Aluno não encontrado');
    alunoId = aluno.id;
  } else if (user.role === 'PROFESSOR' || user.role === 'ADMIN') {
    if (!alunoId) throw new HttpError(400, 'alunoId obrigatório');
    await resolveAlunoForProva({ user, alunoId, write: true });
  } else {
    throw new HttpError(403, 'Sem permissão para criar prova');
  }

  // Validação de negócio: alvo principal (A) no passado não faz sentido.
  // Guarda na app porque partial unique não consegue (função volátil).
  if (input.prioridade === 'A' && new Date(input.data) < new Date()) {
    throw new HttpError(400, 'Race A não pode estar no passado');
  }

  return handleUniqueConflict(alunoId, () =>
    prisma.prova.create({
      data: {
        alunoId,
        modalidade: input.modalidade,
        nome: input.nome,
        data: new Date(input.data),
        prioridade: input.prioridade,
        alvoTempo: input.alvoTempo ?? null,
        local: input.local ?? null,
        detalhes: input.detalhes ?? {},
      },
    }),
  );
}

export async function atualizarProva({ user, provaId, patch }) {
  const existente = await prisma.prova.findUnique({ where: { id: provaId } });
  if (!existente) throw new HttpError(404, 'Prova não encontrada');
  if (user.role === 'NUTRICIONISTA') throw new HttpError(403, 'Sem permissão');
  await resolveAlunoForProva({ user, alunoId: existente.alunoId, write: true });

  const data = {};
  if (patch.modalidade !== undefined) data.modalidade = patch.modalidade;
  if (patch.nome !== undefined) data.nome = patch.nome;
  if (patch.data !== undefined) data.data = new Date(patch.data);
  if (patch.prioridade !== undefined) data.prioridade = patch.prioridade;
  if (patch.arquivada !== undefined) data.arquivada = patch.arquivada;
  if (patch.alvoTempo !== undefined) data.alvoTempo = patch.alvoTempo;
  if (patch.local !== undefined) data.local = patch.local;
  if (patch.detalhes !== undefined) data.detalhes = patch.detalhes;

  // Mesma guarda de negócio do criar — mas só checa se o patch toca em
  // prioridade=A ou em data (cobre os 2 caminhos possíveis pro estado
  // ilegal "A no passado").
  const dataFinal = data.data ?? existente.data;
  const prioFinal = data.prioridade ?? existente.prioridade;
  if (prioFinal === 'A' && data.arquivada !== true && dataFinal < new Date()) {
    throw new HttpError(400, 'Race A não pode estar no passado');
  }

  return handleUniqueConflict(existente.alunoId, () =>
    prisma.prova.update({ where: { id: provaId }, data }),
  );
}

// Atalho explícito pra UI: "Definir como Race A". Equivalente a
// atualizarProva({ prioridade: 'A' }) mas com payload mínimo.
export async function promoverProva({ user, provaId, prioridade }) {
  return atualizarProva({ user, provaId, patch: { prioridade } });
}

// Idempotente — arquivar já arquivada é no-op silencioso (200, não 409).
export async function arquivarProva({ user, provaId }) {
  return atualizarProva({ user, provaId, patch: { arquivada: true } });
}

export async function deleteProva({ user, provaId }) {
  const prova = await prisma.prova.findUnique({ where: { id: provaId } });
  if (!prova) throw new HttpError(404, 'Prova não encontrada');
  if (user.role === 'NUTRICIONISTA') throw new HttpError(403, 'Sem permissão');
  await resolveAlunoForProva({ user, alunoId: prova.alunoId, write: true });
  await prisma.prova.delete({ where: { id: provaId } });
  return { ok: true };
}
