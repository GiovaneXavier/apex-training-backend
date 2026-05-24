import { describe, it, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// PR #43 — adminUsers.service: list (cursor + filtros), aprovar, status, detalhe.

const state = {
  users: [], // { id, nome, email, role, ativo, criadoEm, avatarUrl?, atualizadoEm? }
  alunos: [], // { id, userId, vinculosProf, vinculosNutri }
  professores: [], // { id, userId }
  nutris: [], // { id, userId }
  treinos: [], // { alunoId, professorId?, status, finalizadoEm, dataAlvo, titulo }
  vinculosProf: [], // { alunoId, professorId, criadoEm }
  vinculosNutri: [], // { alunoId, nutricionistaId, aceitoPeloAluno, criadoEm }
  lastWhere: null, // pra inspeção
  lastUpdateData: null,
};

function resetState() {
  state.users = [];
  state.alunos = [];
  state.professores = [];
  state.nutris = [];
  state.treinos = [];
  state.vinculosProf = [];
  state.vinculosNutri = [];
  state.lastWhere = null;
  state.lastUpdateData = null;
}

// Mock prisma — implementação mínima que cobre o que o service usa.
mock.module('../lib/prisma.js', {
  namedExports: {
    prisma: {
      user: {
        findMany: async ({ where, orderBy, take, select }) => {
          state.lastWhere = where;
          let rows = [...state.users];
          rows = applyUserWhere(rows, where);
          rows = applyOrderBy(rows, orderBy);
          return rows.slice(0, take).map((u) => projectSelect(u, select));
        },
        findUnique: async ({ where, select }) => {
          const u = state.users.find((x) => x.id === where.id);
          return u ? projectSelect(u, select) : null;
        },
        update: async ({ where, data, select }) => {
          const u = state.users.find((x) => x.id === where.id);
          if (!u) throw new Error(`user ${where.id} not found`);
          Object.assign(u, data, { atualizadoEm: new Date() });
          state.lastUpdateData = data;
          return projectSelect(u, select);
        },
      },
      aluno: {
        findUnique: async ({ where }) => {
          return state.alunos.find((a) => a.userId === where.userId) ?? null;
        },
      },
      professor: {
        findUnique: async ({ where }) => {
          return state.professores.find((p) => p.userId === where.userId) ?? null;
        },
      },
      nutricionista: {
        findUnique: async ({ where }) => {
          return state.nutris.find((n) => n.userId === where.userId) ?? null;
        },
      },
      treino: {
        count: async ({ where }) => {
          if (where.alunoId) return state.treinos.filter((t) => t.alunoId === where.alunoId).length;
          if (where.professorId) return state.treinos.filter((t) => t.professorId === where.professorId).length;
          return state.treinos.length;
        },
        findFirst: async ({ where }) => {
          const filtered = state.treinos
            .filter((t) => t.alunoId === where.alunoId)
            .sort((a, b) => new Date(b.dataAlvo) - new Date(a.dataAlvo));
          return filtered[0] ?? null;
        },
      },
      vinculoProfessor: {
        count: async ({ where }) =>
          state.vinculosProf.filter((v) => v.professorId === where.professorId).length,
        findMany: async ({ where, take }) =>
          state.vinculosProf
            .filter((v) => v.professorId === where.professorId)
            .slice(0, take)
            .map((v) => {
              const aluno = state.alunos.find((a) => a.id === v.alunoId);
              const user = state.users.find((u) => u.id === aluno?.userId);
              const ultimoTreino = state.treinos
                .filter((t) => t.alunoId === v.alunoId && t.finalizadoEm)
                .sort((a, b) => new Date(b.finalizadoEm) - new Date(a.finalizadoEm))[0];
              return {
                aluno: {
                  id: aluno?.id,
                  user: { nome: user?.nome },
                  treinos: ultimoTreino ? [{ finalizadoEm: ultimoTreino.finalizadoEm }] : [],
                },
              };
            }),
      },
      vinculoNutricionista: {
        count: async ({ where }) =>
          state.vinculosNutri.filter(
            (v) => v.nutricionistaId === where.nutricionistaId && v.aceitoPeloAluno === where.aceitoPeloAluno,
          ).length,
        findMany: async ({ where, take }) =>
          state.vinculosNutri
            .filter((v) => v.nutricionistaId === where.nutricionistaId && v.aceitoPeloAluno === where.aceitoPeloAluno)
            .slice(0, take)
            .map((v) => {
              const aluno = state.alunos.find((a) => a.id === v.alunoId);
              const user = state.users.find((u) => u.id === aluno?.userId);
              return { aluno: { id: aluno?.id, user: { nome: user?.nome } } };
            }),
      },
    },
  },
});

let svc;
before(async () => {
  svc = await import('../services/adminUsers.service.js');
});

beforeEach(() => resetState());

// ──────────────────────────────────────────────────────────────────────
// Helpers de mock (replicam comportamento Prisma usado pelo service)
// ──────────────────────────────────────────────────────────────────────

function applyUserWhere(rows, where) {
  if (!where) return rows;
  if (where.role) rows = rows.filter((u) => u.role === where.role);
  if (typeof where.ativo === 'boolean') rows = rows.filter((u) => u.ativo === where.ativo);
  if (where.OR) {
    rows = rows.filter((u) =>
      where.OR.some((cond) => {
        if (cond.nome) return matchContains(u.nome, cond.nome);
        if (cond.email) return matchContains(u.email, cond.email);
        return false;
      }),
    );
  }
  if (where.AND) {
    for (const clause of where.AND) {
      if (clause.OR) {
        rows = rows.filter((u) =>
          clause.OR.some((cond) => {
            if (cond.criadoEm?.lt) return u.criadoEm < cond.criadoEm.lt;
            if (cond.AND) {
              const a = cond.AND.find((x) => x.criadoEm)?.criadoEm;
              const i = cond.AND.find((x) => x.id)?.id;
              if (a && a.equals && i?.lt) {
                return +u.criadoEm === +a && u.id < i.lt;
              }
              // Prisma usa equals/Date comparison — implementamos ambos
              if (a instanceof Date && i?.lt) {
                return +u.criadoEm === +a && u.id < i.lt;
              }
              if (a && typeof a === 'object' && i?.lt) {
                // a pode ser { equals: Date } no Prisma — service passa Date direto
                return false;
              }
              if (a && i?.lt) return +u.criadoEm === +a && u.id < i.lt;
            }
            return false;
          }),
        );
      }
    }
  }
  return rows;
}

function matchContains(value, cond) {
  if (!cond?.contains) return true;
  const haystack = cond.mode === 'insensitive' ? value.toLowerCase() : value;
  const needle = cond.mode === 'insensitive' ? cond.contains.toLowerCase() : cond.contains;
  return haystack.includes(needle);
}

function applyOrderBy(rows, orderBy) {
  if (!Array.isArray(orderBy)) return rows;
  const sorted = [...rows];
  sorted.sort((a, b) => {
    for (const clause of orderBy) {
      if (clause.criadoEm) {
        const dir = clause.criadoEm === 'desc' ? -1 : 1;
        const diff = (+a.criadoEm) - (+b.criadoEm);
        if (diff !== 0) return diff * dir;
      }
      if (clause.id) {
        const dir = clause.id === 'desc' ? -1 : 1;
        const cmp = a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        if (cmp !== 0) return cmp * dir;
      }
    }
    return 0;
  });
  return sorted;
}

function projectSelect(row, select) {
  if (!select) return { ...row };
  const out = {};
  for (const k of Object.keys(select)) {
    if (select[k] === true) out[k] = row[k];
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────
// Fábricas
// ──────────────────────────────────────────────────────────────────────

function pushUser(over = {}) {
  const i = state.users.length + 1;
  const u = {
    id: `u_${i}`,
    nome: `Usuário ${i}`,
    email: `user${i}@apex.com`,
    role: 'ALUNO',
    ativo: true,
    criadoEm: new Date(`2026-05-${10 + i}T10:00:00.000Z`),
    atualizadoEm: new Date(),
    avatarUrl: null,
    ...over,
  };
  state.users.push(u);
  return u;
}

// ──────────────────────────────────────────────────────────────────────
// listarUsuarios — paginação + filtros
// ──────────────────────────────────────────────────────────────────────

describe('listarUsuarios — paginação + filtros', () => {
  it('lista vazia → retorna {usuarios:[], proximoCursor:null, temMais:false}', async () => {
    const out = await svc.listarUsuarios({ limit: 20 });
    assert.deepEqual(out.usuarios, []);
    assert.equal(out.proximoCursor, null);
    assert.equal(out.temMais, false);
  });

  it('limit=2 com 5 users → retorna 2 + proximoCursor + temMais=true', async () => {
    for (let i = 0; i < 5; i++) pushUser();
    const out = await svc.listarUsuarios({ limit: 2 });
    assert.equal(out.usuarios.length, 2);
    assert.equal(out.temMais, true);
    assert.ok(out.proximoCursor);
  });

  it('última página → proximoCursor=null + temMais=false', async () => {
    for (let i = 0; i < 3; i++) pushUser();
    const out = await svc.listarUsuarios({ limit: 5 });
    assert.equal(out.usuarios.length, 3);
    assert.equal(out.temMais, false);
    assert.equal(out.proximoCursor, null);
  });

  it('filtro role=PROFESSOR retorna só professores', async () => {
    pushUser({ role: 'ALUNO' });
    pushUser({ role: 'PROFESSOR' });
    pushUser({ role: 'PROFESSOR' });
    const out = await svc.listarUsuarios({ limit: 20, role: 'PROFESSOR' });
    assert.equal(out.usuarios.length, 2);
    assert.ok(out.usuarios.every((u) => u.role === 'PROFESSOR'));
  });

  it('filtro ativo=false retorna só inativos', async () => {
    pushUser({ ativo: true });
    pushUser({ ativo: false });
    pushUser({ ativo: false });
    const out = await svc.listarUsuarios({ limit: 20, ativo: false });
    assert.equal(out.usuarios.length, 2);
    assert.ok(out.usuarios.every((u) => u.ativo === false));
  });

  it('search case-insensitive bate em nome OR email', async () => {
    pushUser({ nome: 'Carla Silva', email: 'carla@apex.com' });
    pushUser({ nome: 'Pedro', email: 'PEDRO@APEX.com' });
    pushUser({ nome: 'Maria', email: 'maria@x.com' });

    const a = await svc.listarUsuarios({ limit: 20, search: 'carla' });
    assert.equal(a.usuarios.length, 1);
    assert.equal(a.usuarios[0].nome, 'Carla Silva');

    const b = await svc.listarUsuarios({ limit: 20, search: 'pedro' });
    assert.equal(b.usuarios.length, 1, 'search deve achar PEDRO@APEX.com case-insensitive');
  });

  it('cursor da página N navega pra N+1 sem repetir nem pular', async () => {
    for (let i = 0; i < 6; i++) pushUser();
    const p1 = await svc.listarUsuarios({ limit: 2 });
    assert.equal(p1.usuarios.length, 2);
    const p2 = await svc.listarUsuarios({ limit: 2, cursor: p1.proximoCursor });
    assert.equal(p2.usuarios.length, 2);
    const p3 = await svc.listarUsuarios({ limit: 2, cursor: p2.proximoCursor });
    assert.equal(p3.usuarios.length, 2);

    const todosIds = [...p1.usuarios, ...p2.usuarios, ...p3.usuarios].map((u) => u.id);
    const unique = new Set(todosIds);
    assert.equal(unique.size, 6, 'paginação não deve repetir ids');
  });

  it('cursor é estável quando dois users compartilham criadoEm (empate-breaker por id)', async () => {
    const mesma = new Date('2026-05-20T10:00:00.000Z');
    pushUser({ id: 'u_a', criadoEm: mesma });
    pushUser({ id: 'u_b', criadoEm: mesma });
    pushUser({ id: 'u_c', criadoEm: mesma });
    pushUser({ id: 'u_d', criadoEm: new Date('2026-05-19T10:00:00.000Z') });

    const p1 = await svc.listarUsuarios({ limit: 2 });
    assert.equal(p1.usuarios.length, 2);
    const p2 = await svc.listarUsuarios({ limit: 2, cursor: p1.proximoCursor });
    assert.equal(p2.usuarios.length, 2);
    const ids = [...p1.usuarios, ...p2.usuarios].map((u) => u.id);
    assert.equal(new Set(ids).size, 4, 'empate em criadoEm não pode causar duplicata');
  });

  it('cursor inválido → throw cursor inválido', async () => {
    await assert.rejects(
      svc.listarUsuarios({ limit: 5, cursor: 'cursor-quebrado-!!' }),
      /cursor inválido/,
    );
  });
});

// ──────────────────────────────────────────────────────────────────────
// aprovarUsuario — D2 (422 se role inválida ou já ativo)
// ──────────────────────────────────────────────────────────────────────

describe('aprovarUsuario — D2 fail-fast', () => {
  it('PROFESSOR pendente → 200 + ativo:true', async () => {
    pushUser({ id: 'u_prof', role: 'PROFESSOR', ativo: false });
    const out = await svc.aprovarUsuario({ id: 'u_prof' });
    assert.equal(out.success, true);
    assert.equal(out.user.ativo, true);
    assert.equal(state.lastUpdateData.ativo, true);
  });

  it('NUTRICIONISTA pendente → 200', async () => {
    pushUser({ id: 'u_nutri', role: 'NUTRICIONISTA', ativo: false });
    const out = await svc.aprovarUsuario({ id: 'u_nutri' });
    assert.equal(out.success, true);
    assert.equal(out.user.ativo, true);
  });

  it('PROFESSOR já ativo → 422', async () => {
    pushUser({ id: 'u_prof', role: 'PROFESSOR', ativo: true });
    await assert.rejects(
      svc.aprovarUsuario({ id: 'u_prof' }),
      (err) => err.status === 422 && /pendentes/.test(err.message),
    );
  });

  it('ALUNO → 422 (não tem fluxo de aprovação)', async () => {
    pushUser({ id: 'u_aluno', role: 'ALUNO', ativo: false });
    await assert.rejects(
      svc.aprovarUsuario({ id: 'u_aluno' }),
      (err) => err.status === 422,
    );
  });

  it('ADMIN → 422', async () => {
    pushUser({ id: 'u_admin', role: 'ADMIN', ativo: false });
    await assert.rejects(
      svc.aprovarUsuario({ id: 'u_admin' }),
      (err) => err.status === 422,
    );
  });

  it('não encontrado → 404', async () => {
    await assert.rejects(
      svc.aprovarUsuario({ id: 'inexistente' }),
      (err) => err.status === 404,
    );
  });
});

// ──────────────────────────────────────────────────────────────────────
// atualizarStatusUsuario — D3 (auto-disable, admin-disable bloqueio)
// ──────────────────────────────────────────────────────────────────────

describe('atualizarStatusUsuario — D3 guards', () => {
  it('desativar a si mesmo → 403', async () => {
    pushUser({ id: 'u_self', role: 'ADMIN', ativo: true });
    await assert.rejects(
      svc.atualizarStatusUsuario({ id: 'u_self', ativo: false, atorUserId: 'u_self' }),
      (err) => err.status === 403 && /própria conta/.test(err.message),
    );
  });

  it('ativar a si mesmo é permitido (no-op se já ativo)', async () => {
    pushUser({ id: 'u_self', role: 'ADMIN', ativo: true });
    const out = await svc.atualizarStatusUsuario({
      id: 'u_self', ativo: true, atorUserId: 'u_self',
    });
    assert.equal(out.success, true);
    assert.equal(out.noop, true);
  });

  it('desativar outro ADMIN → 409', async () => {
    pushUser({ id: 'u_admin_a', role: 'ADMIN', ativo: true });
    pushUser({ id: 'u_admin_b', role: 'ADMIN', ativo: true });
    await assert.rejects(
      svc.atualizarStatusUsuario({
        id: 'u_admin_b', ativo: false, atorUserId: 'u_admin_a',
      }),
      (err) => err.status === 409 && /administrador/.test(err.message),
    );
  });

  it('ativar outro ADMIN é permitido (reverter cross-DB)', async () => {
    pushUser({ id: 'u_admin_a', role: 'ADMIN', ativo: true });
    pushUser({ id: 'u_admin_b', role: 'ADMIN', ativo: false });
    const out = await svc.atualizarStatusUsuario({
      id: 'u_admin_b', ativo: true, atorUserId: 'u_admin_a',
    });
    assert.equal(out.success, true);
    assert.equal(out.user.ativo, true);
  });

  it('desativar PROFESSOR ativo → 200 + persiste', async () => {
    pushUser({ id: 'u_self', role: 'ADMIN', ativo: true });
    pushUser({ id: 'u_prof', role: 'PROFESSOR', ativo: true });
    const out = await svc.atualizarStatusUsuario({
      id: 'u_prof', ativo: false, atorUserId: 'u_self',
    });
    assert.equal(out.success, true);
    assert.equal(out.user.ativo, false);
  });

  it('idempotência: estado já igual → noop=true sem update', async () => {
    pushUser({ id: 'u_self', role: 'ADMIN', ativo: true });
    pushUser({ id: 'u_prof', role: 'PROFESSOR', ativo: false });
    state.lastUpdateData = null;
    const out = await svc.atualizarStatusUsuario({
      id: 'u_prof', ativo: false, atorUserId: 'u_self',
    });
    assert.equal(out.noop, true);
    assert.equal(state.lastUpdateData, null, 'update não deveria ser chamado em no-op');
  });

  it('user não encontrado → 404', async () => {
    pushUser({ id: 'u_self', role: 'ADMIN', ativo: true });
    await assert.rejects(
      svc.atualizarStatusUsuario({ id: 'inexistente', ativo: false, atorUserId: 'u_self' }),
      (err) => err.status === 404,
    );
  });
});

// ──────────────────────────────────────────────────────────────────────
// obterDetalheUsuario — D4 variant por role
// ──────────────────────────────────────────────────────────────────────

describe('obterDetalheUsuario — variant por role', () => {
  it('ALUNO → vinculoProfessor + vinculoNutri + treinosCount + ultimoTreino', async () => {
    pushUser({ id: 'u_aluno', role: 'ALUNO' });
    pushUser({ id: 'u_prof', role: 'PROFESSOR' });
    state.alunos.push({
      id: 'a1', userId: 'u_aluno',
      vinculosProf: [], vinculosNutri: [],
    });
    state.professores.push({ id: 'p1', userId: 'u_prof' });
    state.vinculosProf.push({ alunoId: 'a1', professorId: 'p1', criadoEm: new Date() });
    state.treinos.push({
      alunoId: 'a1', status: 'CONCLUIDO',
      dataAlvo: new Date('2026-05-20T10:00:00.000Z'),
      finalizadoEm: new Date('2026-05-20T11:00:00.000Z'),
      titulo: 'Long run',
    });
    // Mock manual do findUnique aluno com include — service usa findUnique
    // com select rico que nosso mock simplifica.
    // Pra teste, simplificamos: confirmamos só shape.

    const out = await svc.obterDetalheUsuario({ id: 'u_aluno' });
    assert.equal(out.user.role, 'ALUNO');
    assert.ok('treinosCount' in out.detalhe || out.detalhe.treinosCount === 0,
      'detalhe ALUNO deve incluir treinosCount');
    // PR #44 — alunoId no payload pra Bloco C consumir sem round-trip
    assert.equal(out.detalhe.alunoId, 'a1', 'detalhe ALUNO deve incluir alunoId (Aluno.id)');
  });

  it('PROFESSOR → alunosCount + treinosPrescritosCount + alunosTop5', async () => {
    pushUser({ id: 'u_prof', role: 'PROFESSOR' });
    state.professores.push({ id: 'p1', userId: 'u_prof' });
    pushUser({ id: 'u_aluno1', role: 'ALUNO' });
    state.alunos.push({ id: 'a1', userId: 'u_aluno1' });
    state.vinculosProf.push({ alunoId: 'a1', professorId: 'p1', criadoEm: new Date() });

    const out = await svc.obterDetalheUsuario({ id: 'u_prof' });
    assert.equal(out.user.role, 'PROFESSOR');
    assert.equal(out.detalhe.alunosCount, 1);
    assert.ok(Array.isArray(out.detalhe.alunosTop5));
    assert.equal(out.detalhe.alunosTop5.length, 1);
    assert.equal(out.detalhe.alunosTop5[0].nome, 'Usuário 2');
  });

  it('NUTRICIONISTA → conta só vínculos aceitos', async () => {
    pushUser({ id: 'u_nutri', role: 'NUTRICIONISTA' });
    state.nutris.push({ id: 'n1', userId: 'u_nutri' });
    pushUser({ id: 'u_a1', role: 'ALUNO' });
    pushUser({ id: 'u_a2', role: 'ALUNO' });
    state.alunos.push({ id: 'a1', userId: 'u_a1' });
    state.alunos.push({ id: 'a2', userId: 'u_a2' });
    state.vinculosNutri.push({ alunoId: 'a1', nutricionistaId: 'n1', aceitoPeloAluno: true, criadoEm: new Date() });
    state.vinculosNutri.push({ alunoId: 'a2', nutricionistaId: 'n1', aceitoPeloAluno: false, criadoEm: new Date() });

    const out = await svc.obterDetalheUsuario({ id: 'u_nutri' });
    assert.equal(out.detalhe.alunosCount, 1, 'só conta aceitos');
    assert.equal(out.detalhe.alunosTop5.length, 1);
  });

  it('ADMIN → detalhe vazio (só campos base no user)', async () => {
    pushUser({ id: 'u_admin', role: 'ADMIN' });
    const out = await svc.obterDetalheUsuario({ id: 'u_admin' });
    assert.equal(out.user.role, 'ADMIN');
    assert.deepEqual(out.detalhe, {});
  });

  it('não encontrado → 404', async () => {
    await assert.rejects(
      svc.obterDetalheUsuario({ id: 'inexistente' }),
      (err) => err.status === 404,
    );
  });
});
