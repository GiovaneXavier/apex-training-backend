import { describe, it, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// Mock prisma — estado em memória para testar exclusivamente as regras
// de validação dinâmica por modalidade (sem tocar Postgres).
const state = {
  aluno: { id: 'aluno-1', userId: 'user-1' },
  treino: null,
  lastUpdateData: null,
};

mock.module('../lib/prisma.js', {
  namedExports: {
    prisma: {
      aluno: { findUnique: async () => state.aluno },
      treino: {
        findUnique: async () => state.treino,
        update: async ({ data }) => {
          state.lastUpdateData = data;
          return { ...state.treino, ...data };
        },
      },
      // Musculação rotativa não é o foco — devolvemos null sempre pra
      // evitar caminhos de RP. Os testes de race vivem em execucao.race.test.js.
      recordePessoal: {
        findUnique: async () => null,
        create: async ({ data }) => ({ id: 'rp-x', ...data, dataRecorde: new Date() }),
        updateMany: async () => ({ count: 0 }),
      },
    },
  },
});

let salvarExecucao;
before(async () => {
  ({ salvarExecucao } = await import('../services/execucao.service.js'));
});

beforeEach(() => {
  state.lastUpdateData = null;
});

const userAluno = { userId: 'user-1', role: 'ALUNO' };

function setTreino(detalhes) {
  state.treino = {
    id: 'treino-1',
    alunoId: 'aluno-1',
    detalhes,
  };
}

describe('salvarExecucao — roteamento por modalidade (PR #11)', () => {
  describe('musculação', () => {
    beforeEach(() => {
      setTreino({
        tipo: 'musculacao',
        exercicios: [
          { nome: 'Supino', realizado: [] },
          { nome: 'Agachamento', realizado: [] },
        ],
      });
    });

    it('aceita execução de exercício prescrito', async () => {
      const { treino } = await salvarExecucao({
        user: userAluno,
        treinoId: 'treino-1',
        input: {
          exercicios: [{ nome: 'Supino', realizado: [{ kg: 80, reps: 10 }] }],
          status: 'CONCLUIDO',
        },
      });
      assert.equal(treino.status, 'CONCLUIDO');
    });

    it('rejeita exercício NÃO prescrito (não pode inventar nome)', async () => {
      await assert.rejects(
        salvarExecucao({
          user: userAluno,
          treinoId: 'treino-1',
          input: {
            exercicios: [{ nome: 'ExercicioFantasma', realizado: [{ kg: 999, reps: 1 }] }],
          },
        }),
        /não está prescrito/,
      );
    });

    it('rejeita uso de `realizado` (musculação usa só exercicios[])', async () => {
      await assert.rejects(
        salvarExecucao({
          user: userAluno,
          treinoId: 'treino-1',
          input: { realizado: { foo: 'bar' } },
        }),
        /Musculação usa exercicios/,
      );
    });
  });

  describe('corrida', () => {
    beforeEach(() => {
      setTreino({ tipo: 'corrida', distanciaKm: 5 });
    });

    it('aceita realizado válido e grava no jsonb', async () => {
      await salvarExecucao({
        user: userAluno,
        treinoId: 'treino-1',
        input: {
          realizado: { distanciaKm: 5.2, duracaoSeg: 1850, ritmoMedioMinKm: '5:55' },
          status: 'CONCLUIDO',
        },
      });
      assert.equal(state.lastUpdateData.detalhes.realizado.distanciaKm, 5.2);
    });

    it('rejeita campo desconhecido em realizado (.strict — anti poisoning)', async () => {
      await assert.rejects(
        salvarExecucao({
          user: userAluno,
          treinoId: 'treino-1',
          input: { realizado: { distanciaKm: 5, secretLeak: 'cookie' } },
        }),
      );
    });

    it('rejeita uso de exercicios[] (não-musculação)', async () => {
      await assert.rejects(
        salvarExecucao({
          user: userAluno,
          treinoId: 'treino-1',
          input: { exercicios: [{ nome: 'Supino', realizado: [] }] },
        }),
        /não aceita exercicios/,
      );
    });

    it('rejeita distância absurda (cap de 500km)', async () => {
      await assert.rejects(
        salvarExecucao({
          user: userAluno,
          treinoId: 'treino-1',
          input: { realizado: { distanciaKm: 9999 } },
        }),
      );
    });
  });

  describe('ciclismo', () => {
    it('rejeita potência absurda (cap de 3000W)', async () => {
      setTreino({ tipo: 'ciclismo' });
      await assert.rejects(
        salvarExecucao({
          user: userAluno,
          treinoId: 'treino-1',
          input: { realizado: { potenciaMediaW: 50000 } },
        }),
      );
    });
  });

  describe('hyrox', () => {
    it('aceita blocos com formato válido', async () => {
      setTreino({ tipo: 'hyrox', blocos: [{ formato: 'FOR_TIME' }] });
      await salvarExecucao({
        user: userAluno,
        treinoId: 'treino-1',
        input: {
          realizado: { duracaoTotalSeg: 3600, rounds: 5, blocos: [{ rounds: 5, duracaoSeg: 600 }] },
        },
      });
      assert.equal(state.lastUpdateData.detalhes.realizado.rounds, 5);
    });

    it('rejeita campo extra em bloco realizado', async () => {
      setTreino({ tipo: 'hyrox', blocos: [{ formato: 'FOR_TIME' }] });
      await assert.rejects(
        salvarExecucao({
          user: userAluno,
          treinoId: 'treino-1',
          input: { realizado: { blocos: [{ rounds: 1, x: 'y' }] } },
        }),
      );
    });
  });

  describe('tipo desconhecido', () => {
    it('rejeita 400 com mensagem clara (anti schema-drift)', async () => {
      setTreino({ tipo: 'alquimia' });
      await assert.rejects(
        salvarExecucao({
          user: userAluno,
          treinoId: 'treino-1',
          input: { realizado: { foo: 'bar' } },
        }),
        /sem schema de validação/,
      );
    });
  });
});
