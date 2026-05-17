import { describe, it, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// PR #14 (audit 2.21) — vincularPorEmail silencioso anti-enumeration.
//
// Validamos que a resposta da função NUNCA distingue:
//   - email não existe
//   - email é de outro role (professor/nutri)
//   - email é aluno mas sem perfil
//   - email é aluno já vinculado
//   - email é aluno novo (cria vínculo)
// Em todos os casos: `{ ok: true }`. O EFEITO COLATERAL (criar ou não
// o vínculo no DB) varia, e os testes inspecionam isso via mock.

const state = {
  professorByUserId: new Map(),
  userByEmail: new Map(),
  alunoByUserId: new Map(),
  vinculos: new Map(), // key: `${alunoId}|${profId}`
  createdVinculos: [],
};

mock.module('../lib/prisma.js', {
  namedExports: {
    prisma: {
      professor: {
        findUnique: async ({ where }) => state.professorByUserId.get(where.userId) ?? null,
      },
      user: {
        findUnique: async ({ where }) => state.userByEmail.get(where.email) ?? null,
      },
      aluno: {
        findUnique: async ({ where }) => state.alunoByUserId.get(where.userId) ?? null,
      },
      vinculoProfessor: {
        findUnique: async ({ where }) => {
          const { alunoId, professorId } = where.alunoId_professorId;
          return state.vinculos.get(`${alunoId}|${professorId}`) ?? null;
        },
        create: async ({ data }) => {
          const row = { id: `v-${state.createdVinculos.length + 1}`, ...data, criadoEm: new Date() };
          state.vinculos.set(`${data.alunoId}|${data.professorId}`, row);
          state.createdVinculos.push(row);
          return row;
        },
      },
    },
  },
});

let vincularPorEmail;
before(async () => {
  ({ vincularPorEmail } = await import('../services/professor.service.js'));
});

beforeEach(() => {
  state.professorByUserId.clear();
  state.userByEmail.clear();
  state.alunoByUserId.clear();
  state.vinculos.clear();
  state.createdVinculos = [];
  state.professorByUserId.set('user-prof-1', { id: 'prof-1', userId: 'user-prof-1' });
});

describe('vincularPorEmail — anti-enumeration (PR #14)', () => {
  it('email inexistente → { ok:true }, NÃO cria vínculo', async () => {
    const result = await vincularPorEmail('user-prof-1', 'ninguem@nao-existe.com');
    assert.deepEqual(result, { ok: true });
    assert.equal(state.createdVinculos.length, 0);
  });

  it('email é de PROFESSOR → { ok:true }, NÃO cria vínculo', async () => {
    state.userByEmail.set('outro@prof.com', {
      id: 'user-outro', role: 'PROFESSOR', email: 'outro@prof.com', nome: 'Outro Prof',
    });
    const result = await vincularPorEmail('user-prof-1', 'outro@prof.com');
    assert.deepEqual(result, { ok: true });
    assert.equal(state.createdVinculos.length, 0);
  });

  it('email é de NUTRICIONISTA → { ok:true }, NÃO cria vínculo', async () => {
    state.userByEmail.set('nutri@x.com', {
      id: 'user-nutri', role: 'NUTRICIONISTA', email: 'nutri@x.com', nome: 'Nutri',
    });
    const result = await vincularPorEmail('user-prof-1', 'nutri@x.com');
    assert.deepEqual(result, { ok: true });
    assert.equal(state.createdVinculos.length, 0);
  });

  it('email é ALUNO sem perfil cadastrado → { ok:true }, NÃO cria vínculo', async () => {
    state.userByEmail.set('aluno-fantasma@x.com', {
      id: 'user-fantasma', role: 'ALUNO', email: 'aluno-fantasma@x.com', nome: 'Fantasma',
    });
    // intencional: alunoByUserId vazio pra "user-fantasma"
    const result = await vincularPorEmail('user-prof-1', 'aluno-fantasma@x.com');
    assert.deepEqual(result, { ok: true });
    assert.equal(state.createdVinculos.length, 0);
  });

  it('email é ALUNO novo → { ok:true }, CRIA vínculo', async () => {
    state.userByEmail.set('aluno@x.com', {
      id: 'user-aluno-1', role: 'ALUNO', email: 'aluno@x.com', nome: 'Aluno',
    });
    state.alunoByUserId.set('user-aluno-1', { id: 'aluno-1', userId: 'user-aluno-1' });

    const result = await vincularPorEmail('user-prof-1', 'aluno@x.com');
    assert.deepEqual(result, { ok: true });
    assert.equal(state.createdVinculos.length, 1);
    assert.equal(state.createdVinculos[0].alunoId, 'aluno-1');
    assert.equal(state.createdVinculos[0].professorId, 'prof-1');
  });

  it('email é ALUNO já vinculado → { ok:true }, NÃO duplica (idempotente)', async () => {
    state.userByEmail.set('aluno@x.com', {
      id: 'user-aluno-1', role: 'ALUNO', email: 'aluno@x.com', nome: 'Aluno',
    });
    state.alunoByUserId.set('user-aluno-1', { id: 'aluno-1', userId: 'user-aluno-1' });
    state.vinculos.set('aluno-1|prof-1', { id: 'v-existing', alunoId: 'aluno-1', professorId: 'prof-1' });

    const result = await vincularPorEmail('user-prof-1', 'aluno@x.com');
    assert.deepEqual(result, { ok: true });
    assert.equal(state.createdVinculos.length, 0); // nada criado
  });

  it('normaliza email (lowercase + trim) antes do lookup', async () => {
    state.userByEmail.set('aluno@x.com', {
      id: 'user-aluno-1', role: 'ALUNO', email: 'aluno@x.com', nome: 'Aluno',
    });
    state.alunoByUserId.set('user-aluno-1', { id: 'aluno-1', userId: 'user-aluno-1' });

    const result = await vincularPorEmail('user-prof-1', '  ALUNO@X.COM  ');
    assert.deepEqual(result, { ok: true });
    assert.equal(state.createdVinculos.length, 1);
  });

  it('professor sem perfil cadastrado → throw 404 (auth real, NÃO enumeration)', async () => {
    await assert.rejects(
      vincularPorEmail('user-prof-fantasma', 'qualquer@x.com'),
      (err) => err?.status === 404,
    );
  });
});
