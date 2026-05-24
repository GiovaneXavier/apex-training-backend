// PR #43 (Sprint 16 — Bloco B) — Service de Gerenciamento de Usuários.
//
// 4 operações expostas pro admin:
//   listarUsuarios    — cursor-based paginação + filtros (search, role, ativo)
//   aprovarUsuario    — destrava PROFESSOR/NUTRI pendente (ativo=false → true)
//   atualizarStatus   — toggle genérico ativo, com guards de segurança
//   obterDetalhe      — drawer rico (counts + top 5) variando por role
//
// Decisões do briefing:
//   - cursor opaco base64 {lastCriadoEm, lastId} pra ordenação estável
//   - search ILIKE simples (sem GIN trgm ainda — YAGNI confirmado)
//   - aprovar fora de PROFESSOR/NUTRI pendente → 422 (fail-fast)
//   - desativar a si mesmo → 403; desativar outro ADMIN → 409
//   - detalhe traz counts + alunosTop5 (não lista completa, evita N+1 no drawer)

import { prisma } from '../lib/prisma.js';
import { HttpError } from '../middleware/errorHandler.js';
import { encodeCursor, decodeCursor } from '../lib/cursor.js';

// ──────────────────────────────────────────────────────────────────────
// listarUsuarios — paginação cursor-based + filtros
// ──────────────────────────────────────────────────────────────────────

const USER_LIST_SELECT = {
  id: true,
  nome: true,
  email: true,
  role: true,
  ativo: true,
  criadoEm: true,
};

export async function listarUsuarios({ limit, cursor, search, role, ativo }) {
  const where = {};
  if (role) where.role = role;
  if (typeof ativo === 'boolean') where.ativo = ativo;

  // search: ILIKE em nome OR email. mode:'insensitive' usa lower() no
  // Postgres. Sem índice dedicado por enquanto (D5 — YAGNI até 10k+).
  if (search) {
    where.OR = [
      { nome: { contains: search, mode: 'insensitive' } },
      { email: { contains: search, mode: 'insensitive' } },
    ];
  }

  // Cursor: filtro de exclusão "estritamente depois do último item da
  // página anterior". orderBy DESC → "depois" = `(criadoEm, id) <
  // (lastCriadoEm, lastId)` em ordem lexicográfica de tupla.
  // Prisma não tem tuple-compare nativo, então expandimos manualmente:
  //   criadoEm < last  OR  (criadoEm = last AND id < lastId)
  const decoded = cursor ? decodeCursor(cursor) : null;
  if (decoded?.lastCriadoEm && decoded?.lastId) {
    const lastDate = new Date(decoded.lastCriadoEm);
    const cursorFilter = {
      OR: [
        { criadoEm: { lt: lastDate } },
        { AND: [{ criadoEm: lastDate }, { id: { lt: decoded.lastId } }] },
      ],
    };
    // Combina com filtros anteriores via AND raiz pra não conflitar com
    // o where.OR de search (que é outro nível).
    where.AND = [
      ...(where.AND ?? []),
      cursorFilter,
    ];
  }

  // limit+1 pra detectar "tem próxima página" sem fazer count extra.
  const rows = await prisma.user.findMany({
    where,
    orderBy: [{ criadoEm: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    select: USER_LIST_SELECT,
  });

  const temMais = rows.length > limit;
  const usuarios = temMais ? rows.slice(0, limit) : rows;
  const ultimo = usuarios[usuarios.length - 1];
  const proximoCursor = temMais && ultimo
    ? encodeCursor({
        lastCriadoEm: ultimo.criadoEm.toISOString(),
        lastId: ultimo.id,
      })
    : null;

  return { usuarios, proximoCursor, temMais };
}

// ──────────────────────────────────────────────────────────────────────
// aprovarUsuario — destrava PROFESSOR/NUTRI pendente
// ──────────────────────────────────────────────────────────────────────

export async function aprovarUsuario({ id }) {
  const user = await prisma.user.findUnique({
    where: { id },
    select: USER_LIST_SELECT,
  });
  if (!user) throw new HttpError(404, 'Usuário não encontrado');

  // Aprovar só faz sentido pra PROFESSOR/NUTRI que ainda estão inativos
  // aguardando o sinal verde do admin. ALUNO já nasce ativo; ADMIN é
  // meta. Fail-fast com mensagem semântica (D2 batido como 422).
  const podeAprovar = (user.role === 'PROFESSOR' || user.role === 'NUTRICIONISTA') && user.ativo === false;
  if (!podeAprovar) {
    throw new HttpError(
      422,
      `Aprovação só vale pra PROFESSOR/NUTRICIONISTA pendentes (alvo: role=${user.role}, ativo=${user.ativo})`,
    );
  }

  const atualizado = await prisma.user.update({
    where: { id },
    data: { ativo: true },
    select: USER_LIST_SELECT,
  });

  return { success: true, user: atualizado };
}

// ──────────────────────────────────────────────────────────────────────
// atualizarStatus — toggle genérico com guards
// ──────────────────────────────────────────────────────────────────────

export async function atualizarStatusUsuario({ id, ativo, atorUserId }) {
  // Guard 1 (D3) — auto-desativar bloqueia. Vale só pra desativação;
  // ativar a si mesmo é no-op operacional irrelevante mas inofensivo.
  if (ativo === false && id === atorUserId) {
    throw new HttpError(403, 'Não pode desativar a própria conta');
  }

  const user = await prisma.user.findUnique({
    where: { id },
    select: { id: true, role: true, ativo: true },
  });
  if (!user) throw new HttpError(404, 'Usuário não encontrado');

  // Guard 2 (D3) — desativar outro admin via UI bloqueia. Reversão
  // exige acesso direto ao DB (caminho consciente). Ativar admin OK.
  if (user.role === 'ADMIN' && ativo === false && id !== atorUserId) {
    throw new HttpError(409, 'Não pode desativar outro administrador via UI; use DB direto');
  }

  // Idempotência: estado já igual ao pedido → no-op com 200.
  if (user.ativo === ativo) {
    const atual = await prisma.user.findUnique({ where: { id }, select: USER_LIST_SELECT });
    return { success: true, user: atual, noop: true };
  }

  const atualizado = await prisma.user.update({
    where: { id },
    data: { ativo },
    select: USER_LIST_SELECT,
  });

  return { success: true, user: atualizado, noop: false };
}

// ──────────────────────────────────────────────────────────────────────
// obterDetalhe — drawer rico, variant por role (D4 batido)
// ──────────────────────────────────────────────────────────────────────

export async function obterDetalheUsuario({ id }) {
  const user = await prisma.user.findUnique({
    where: { id },
    select: {
      id: true,
      nome: true,
      email: true,
      role: true,
      ativo: true,
      avatarUrl: true,
      criadoEm: true,
      atualizadoEm: true,
    },
  });
  if (!user) throw new HttpError(404, 'Usuário não encontrado');

  const detalhe = await detalhePorRole(user);
  return { user, detalhe };
}

async function detalhePorRole(user) {
  switch (user.role) {
    case 'ALUNO':
      return detalheAluno(user.id);
    case 'PROFESSOR':
      return detalheProfessor(user.id);
    case 'NUTRICIONISTA':
      return detalheNutricionista(user.id);
    case 'ADMIN':
    default:
      return {};
  }
}

async function detalheAluno(userId) {
  const aluno = await prisma.aluno.findUnique({
    where: { userId },
    select: {
      id: true,
      vinculosProf: {
        take: 1,
        orderBy: { criadoEm: 'desc' },
        select: {
          professor: {
            select: { id: true, user: { select: { nome: true } } },
          },
        },
      },
      vinculosNutri: {
        take: 1,
        orderBy: { criadoEm: 'desc' },
        select: {
          nutricionista: {
            select: { id: true, user: { select: { nome: true } } },
          },
        },
      },
    },
  });
  if (!aluno) return {}; // user sem perfil aluno → drawer vazio (recuperável)

  const [treinosCount, ultimoTreino] = await Promise.all([
    prisma.treino.count({ where: { alunoId: aluno.id } }),
    prisma.treino.findFirst({
      where: { alunoId: aluno.id },
      orderBy: { dataAlvo: 'desc' },
      select: { dataAlvo: true, status: true, titulo: true },
    }),
  ]);

  const vp = aluno.vinculosProf[0]?.professor;
  const vn = aluno.vinculosNutri[0]?.nutricionista;
  return {
    vinculoProfessor: vp ? { id: vp.id, nome: vp.user.nome } : null,
    vinculoNutri: vn ? { id: vn.id, nome: vn.user.nome } : null,
    treinosCount,
    ultimoTreino,
  };
}

async function detalheProfessor(userId) {
  const professor = await prisma.professor.findUnique({
    where: { userId },
    select: { id: true },
  });
  if (!professor) return {};

  // Top 5 alunos ordenados pelo último treino finalizado (mais ativos
  // primeiro). Sem treino concluído → cai pro final por NULL ordering.
  const [alunosCount, treinosPrescritosCount, top5Raw] = await Promise.all([
    prisma.vinculoProfessor.count({ where: { professorId: professor.id } }),
    prisma.treino.count({ where: { professorId: professor.id } }),
    prisma.vinculoProfessor.findMany({
      where: { professorId: professor.id },
      take: 5,
      orderBy: { criadoEm: 'desc' },
      select: {
        aluno: {
          select: {
            id: true,
            user: { select: { nome: true } },
            treinos: {
              where: { finalizadoEm: { not: null } },
              orderBy: { finalizadoEm: 'desc' },
              take: 1,
              select: { finalizadoEm: true },
            },
          },
        },
      },
    }),
  ]);

  const alunosTop5 = top5Raw.map((v) => ({
    id: v.aluno.id,
    nome: v.aluno.user.nome,
    ultimaAtividade: v.aluno.treinos[0]?.finalizadoEm ?? null,
  }));

  return { alunosCount, treinosPrescritosCount, alunosTop5 };
}

async function detalheNutricionista(userId) {
  const nutri = await prisma.nutricionista.findUnique({
    where: { userId },
    select: { id: true },
  });
  if (!nutri) return {};

  // alunosCount conta só vínculos aceitos pelo aluno — alinha com o
  // que o próprio nutri vê em "Meus alunos" (UX consistente entre
  // visão dele e visão do admin sobre ele).
  const [alunosCount, top5Raw] = await Promise.all([
    prisma.vinculoNutricionista.count({
      where: { nutricionistaId: nutri.id, aceitoPeloAluno: true },
    }),
    prisma.vinculoNutricionista.findMany({
      where: { nutricionistaId: nutri.id, aceitoPeloAluno: true },
      take: 5,
      orderBy: { criadoEm: 'desc' },
      select: {
        aluno: {
          select: { id: true, user: { select: { nome: true } } },
        },
      },
    }),
  ]);

  const alunosTop5 = top5Raw.map((v) => ({
    id: v.aluno.id,
    nome: v.aluno.user.nome,
  }));

  return { alunosCount, alunosTop5 };
}
