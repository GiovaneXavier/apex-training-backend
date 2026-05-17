import { describe, it, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// PR #18a — detalheAluno(nutri) propaga `aceitoPeloAluno` no retorno
// para o front conseguir gatear UI de escrita. O backend continua
// retornando 403 se o aceite não estiver cravado (defesa primária);
// a flag no payload é defesa em profundidade UX.

const state = {
  nutri: null,
  vinculo: null,
  aluno: null,
  treinos: [],
  provas: [],
};

mock.module('../lib/prisma.js', {
  namedExports: {
    prisma: {
      nutricionista: { findUnique: async () => state.nutri },
      vinculoNutricionista: { findUnique: async () => state.vinculo },
      aluno: {
        findUnique: async ({ where }) =>
          where.id === state.aluno?.id ? state.aluno : null,
      },
      treino: { findMany: async () => state.treinos },
      prova: { findMany: async () => state.provas },
    },
  },
});

let detalheAluno;
before(async () => {
  ({ detalheAluno } = await import('../services/nutri.service.js'));
});

beforeEach(() => {
  state.nutri = { id: 'nutri-1', userId: 'user-nutri-1' };
  state.vinculo = {
    id: 'v-1', alunoId: 'aluno-1', nutricionistaId: 'nutri-1',
    aceitoPeloAluno: true,
  };
  state.aluno = {
    id: 'aluno-1', userId: 'user-aluno-1',
    pesoKg: 80, alturaCm: 178, dataNascimento: null,
    user: { nome: 'João', email: 'joao@x.com', avatarUrl: null },
  };
  state.treinos = [];
  state.provas = [];
});

describe('nutri.detalheAluno — propagação de aceitoPeloAluno (PR #18a)', () => {
  it('aceite=true → retorna detalhe com aceitoPeloAluno=true', async () => {
    const out = await detalheAluno('user-nutri-1', 'aluno-1');
    assert.equal(out.aceitoPeloAluno, true);
    assert.equal(out.aluno.id, 'aluno-1');
    assert.equal(out.aluno.nome, 'João');
  });

  it('vínculo SEM aceite → 403 (regra primária mantida)', async () => {
    state.vinculo = { ...state.vinculo, aceitoPeloAluno: false };
    await assert.rejects(
      detalheAluno('user-nutri-1', 'aluno-1'),
      (err) => err?.status === 403,
    );
  });

  it('SEM vínculo → 403', async () => {
    state.vinculo = null;
    await assert.rejects(
      detalheAluno('user-nutri-1', 'aluno-1'),
      (err) => err?.status === 403,
    );
  });

  it('nutricionista sem perfil → 404', async () => {
    state.nutri = null;
    await assert.rejects(
      detalheAluno('user-nutri-fantasma', 'aluno-1'),
      (err) => err?.status === 404,
    );
  });
});
