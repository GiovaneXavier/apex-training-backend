import { describe, it, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// PR #44 — adminProfessores.service: list ativos pro dropdown.

const state = {
  professores: [], // { id, user: {ativo, role, nome, email} }
  lastWhere: null,
  lastOrderBy: null,
};

function resetState() {
  state.professores = [];
  state.lastWhere = null;
  state.lastOrderBy = null;
}

mock.module('../lib/prisma.js', {
  namedExports: {
    prisma: {
      professor: {
        findMany: async ({ where, take, orderBy }) => {
          state.lastWhere = where;
          state.lastOrderBy = orderBy;
          let rows = state.professores.filter((p) => {
            if (where?.user?.ativo === true && p.user.ativo !== true) return false;
            if (where?.user?.role === 'PROFESSOR' && p.user.role !== 'PROFESSOR') return false;
            if (where?.user?.OR) {
              const m = where.user.OR.some((cond) => {
                if (cond.nome?.contains) {
                  return p.user.nome.toLowerCase().includes(cond.nome.contains.toLowerCase());
                }
                if (cond.email?.contains) {
                  return p.user.email.toLowerCase().includes(cond.email.contains.toLowerCase());
                }
                return false;
              });
              if (!m) return false;
            }
            return true;
          });
          if (orderBy?.user?.nome === 'asc') {
            rows = rows.sort((a, b) => a.user.nome.localeCompare(b.user.nome));
          }
          return rows.slice(0, take).map((p) => ({
            id: p.id,
            user: { nome: p.user.nome, email: p.user.email },
          }));
        },
      },
    },
  },
});

let svc;
before(async () => {
  svc = await import('../services/adminProfessores.service.js');
});

beforeEach(() => resetState());

function pushProf({ id, nome, email, ativo = true, role = 'PROFESSOR' }) {
  state.professores.push({ id, user: { ativo, role, nome, email } });
}

describe('listarProfessoresAtivos', () => {
  it('lista vazia → {professores: []}', async () => {
    const out = await svc.listarProfessoresAtivos({ limit: 20 });
    assert.deepEqual(out, { professores: [] });
  });

  it('filtra só user.ativo=true', async () => {
    pushProf({ id: 'p1', nome: 'Ana', email: 'ana@x.com', ativo: true });
    pushProf({ id: 'p2', nome: 'Bia', email: 'bia@x.com', ativo: false });
    const out = await svc.listarProfessoresAtivos({ limit: 20 });
    assert.equal(out.professores.length, 1);
    assert.equal(out.professores[0].id, 'p1');
  });

  it('search case-insensitive em nome OR email', async () => {
    pushProf({ id: 'p1', nome: 'Carla Silva', email: 'carla@apex.com' });
    pushProf({ id: 'p2', nome: 'Pedro', email: 'pedro@APEX.com' });
    pushProf({ id: 'p3', nome: 'Maria', email: 'maria@x.com' });

    const a = await svc.listarProfessoresAtivos({ search: 'carla', limit: 20 });
    assert.equal(a.professores.length, 1);

    const b = await svc.listarProfessoresAtivos({ search: 'apex', limit: 20 });
    assert.equal(b.professores.length, 2, 'apex bate em carla@apex.com e pedro@APEX.com (insensitive)');
  });

  it('flatten → {id, nome, email} sem user nesting', async () => {
    pushProf({ id: 'p1', nome: 'Ana', email: 'ana@x.com' });
    const out = await svc.listarProfessoresAtivos({ limit: 20 });
    assert.deepEqual(out.professores[0], { id: 'p1', nome: 'Ana', email: 'ana@x.com' });
  });

  it('orderBy alfabético por nome', async () => {
    pushProf({ id: 'p1', nome: 'Carlos' });
    pushProf({ id: 'p2', nome: 'Ana' });
    pushProf({ id: 'p3', nome: 'Beatriz' });
    const out = await svc.listarProfessoresAtivos({ limit: 20 });
    assert.deepEqual(out.professores.map((p) => p.nome), ['Ana', 'Beatriz', 'Carlos']);
  });

  it('respeita limit', async () => {
    pushProf({ id: 'p1', nome: 'A' });
    pushProf({ id: 'p2', nome: 'B' });
    pushProf({ id: 'p3', nome: 'C' });
    const out = await svc.listarProfessoresAtivos({ limit: 2 });
    assert.equal(out.professores.length, 2);
  });
});
