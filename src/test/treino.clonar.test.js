import { describe, it, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// PR #16 — clonarTreino: cobre auth, ACL, sanitização de execução e
// janela temporal do schema.

const state = {
  treino: null,
  professorByUserId: new Map(),
  vinculos: new Map(), // key `${alunoId}|${profId}`
  alunoById: new Map(),
  alunoByUserId: new Map(),
  created: null,
};

mock.module('../lib/prisma.js', {
  namedExports: {
    prisma: {
      treino: {
        findUnique: async ({ where }) => (state.treino && state.treino.id === where.id ? state.treino : null),
        create: async ({ data }) => {
          state.created = { id: 'novo-treino-1', ...data, criadoEm: new Date() };
          return state.created;
        },
      },
      professor: {
        findUnique: async ({ where }) => state.professorByUserId.get(where.userId) ?? null,
      },
      aluno: {
        findUnique: async ({ where }) => {
          if (where.userId) return state.alunoByUserId.get(where.userId) ?? null;
          if (where.id) return state.alunoById.get(where.id) ?? null;
          return null;
        },
      },
      vinculoProfessor: {
        findUnique: async ({ where }) => {
          const { alunoId, professorId } = where.alunoId_professorId;
          return state.vinculos.get(`${alunoId}|${professorId}`) ?? null;
        },
      },
      vinculoNutricionista: { findUnique: async () => null },
      nutricionista: { findUnique: async () => null },
    },
  },
});

let clonarTreino;
before(async () => {
  ({ clonarTreino } = await import('../services/treino.service.js'));
});

beforeEach(() => {
  state.treino = null;
  state.created = null;
  state.professorByUserId.clear();
  state.vinculos.clear();
  state.alunoById.clear();
  state.alunoByUserId.clear();

  state.professorByUserId.set('user-prof-1', { id: 'prof-1', userId: 'user-prof-1' });
  state.alunoById.set('aluno-1', { id: 'aluno-1', userId: 'user-aluno-1' });
  state.vinculos.set('aluno-1|prof-1', { alunoId: 'aluno-1', professorId: 'prof-1' });
});

const userProf = { userId: 'user-prof-1', role: 'PROFESSOR' };
const dataAlvoFuturo = () => new Date(Date.now() + 7 * 86_400_000).toISOString();

describe('clonarTreino — auth + ACL (PR #16)', () => {
  it('ALUNO tenta clonar → 403', async () => {
    state.treino = {
      id: 'treino-1', alunoId: 'aluno-1', professorId: 'prof-1',
      modalidade: 'MUSCULACAO', titulo: 'A',
      detalhes: { tipo: 'musculacao', exercicios: [] }, rotinaId: null,
    };
    await assert.rejects(
      clonarTreino({
        user: { userId: 'user-aluno-1', role: 'ALUNO' },
        treinoId: 'treino-1',
        dataAlvo: dataAlvoFuturo(),
      }),
      (err) => err?.status === 403,
    );
  });

  it('PROFESSOR sem vínculo → 403', async () => {
    state.treino = {
      id: 'treino-1', alunoId: 'aluno-1', professorId: 'prof-outro',
      modalidade: 'CORRIDA', titulo: 'A', detalhes: { tipo: 'corrida' }, rotinaId: null,
    };
    state.vinculos.clear(); // remove vínculo

    await assert.rejects(
      clonarTreino({ user: userProf, treinoId: 'treino-1', dataAlvo: dataAlvoFuturo() }),
      (err) => err?.status === 403,
    );
  });

  it('Treino inexistente → 404', async () => {
    await assert.rejects(
      clonarTreino({ user: userProf, treinoId: 'fantasma', dataAlvo: dataAlvoFuturo() }),
      (err) => err?.status === 404,
    );
  });
});

describe('clonarTreino — sanitização do detalhes', () => {
  it('musculação: zera o realizado de cada exercício', async () => {
    state.treino = {
      id: 'treino-1', alunoId: 'aluno-1', professorId: 'prof-1',
      modalidade: 'MUSCULACAO', titulo: 'Push A',
      detalhes: {
        tipo: 'musculacao',
        exercicios: [
          { nome: 'Supino', prescrito: { series: 4, reps: 10 }, realizado: [{ kg: 80, reps: 10 }] },
          { nome: 'Crucifixo', prescrito: { series: 3 }, realizado: [{ kg: 20, reps: 12 }] },
        ],
      },
      rotinaId: 'rot-1',
    };

    await clonarTreino({ user: userProf, treinoId: 'treino-1', dataAlvo: dataAlvoFuturo() });

    assert.equal(state.created.status, 'PENDENTE');
    assert.equal(state.created.alunoId, 'aluno-1');
    assert.equal(state.created.rotinaId, 'rot-1'); // mantém link à rotina-mãe
    assert.equal(state.created.detalhes.exercicios[0].realizado.length, 0);
    assert.equal(state.created.detalhes.exercicios[1].realizado.length, 0);
    // Prescrição preservada
    assert.equal(state.created.detalhes.exercicios[0].prescrito.series, 4);
  });

  it('corrida: zera o realizado (passa de objeto para null)', async () => {
    state.treino = {
      id: 'treino-2', alunoId: 'aluno-1', professorId: 'prof-1',
      modalidade: 'CORRIDA', titulo: 'Intervalado 5K',
      detalhes: {
        tipo: 'corrida',
        distanciaKm: 5,
        realizado: { distanciaKm: 5.2, duracaoSeg: 1800 },
      },
      rotinaId: null,
    };

    await clonarTreino({ user: userProf, treinoId: 'treino-2', dataAlvo: dataAlvoFuturo() });

    assert.equal(state.created.detalhes.realizado, null);
    assert.equal(state.created.detalhes.distanciaKm, 5); // prescrição mantida
  });

  it('NÃO muta o detalhes original (clone defensivo)', async () => {
    const detalhesOriginal = {
      tipo: 'musculacao',
      exercicios: [{ nome: 'Supino', realizado: [{ kg: 80, reps: 10 }] }],
    };
    state.treino = {
      id: 'treino-3', alunoId: 'aluno-1', professorId: 'prof-1',
      modalidade: 'MUSCULACAO', titulo: 'X',
      detalhes: detalhesOriginal, rotinaId: null,
    };

    await clonarTreino({ user: userProf, treinoId: 'treino-3', dataAlvo: dataAlvoFuturo() });

    // Original intacto
    assert.equal(detalhesOriginal.exercicios[0].realizado.length, 1);
  });
});
