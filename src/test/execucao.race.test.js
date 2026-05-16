import { describe, it, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// Mock do Prisma client ANTES de importar o service.
// Estado em memória pra simular cenários de race sem subir Postgres.
const state = {
  aluno: { id: 'aluno-1', userId: 'user-1' },
  treino: {
    id: 'treino-1',
    alunoId: 'aluno-1',
    detalhes: {
      tipo: 'musculacao',
      exercicios: [{ nome: 'Supino', realizado: [] }],
    },
  },
  rps: new Map(), // key: `${exercicio}|${reps}` → row
  // hooks para forçar P2002 / race entre findUnique e create
  beforeCreate: null,
};

function chave(args) {
  // args.where = { RecordePessoal_ativo_unq: {alunoId, exercicio, metrica, reps} }
  const k = args.where.RecordePessoal_ativo_unq;
  return `${k.exercicio}|${k.reps}`;
}

mock.module('../lib/prisma.js', {
  namedExports: {
    prisma: {
      aluno: {
        findUnique: async () => state.aluno,
      },
      treino: {
        findUnique: async () => state.treino,
        update: async ({ data }) => ({ ...state.treino, ...data }),
      },
      recordePessoal: {
        findUnique: async (args) => state.rps.get(chave(args)) ?? null,
        create: async ({ data }) => {
          if (state.beforeCreate) {
            await state.beforeCreate(data);
            state.beforeCreate = null;
          }
          const k = `${data.exercicio}|${data.reps}`;
          if (state.rps.has(k)) {
            const err = new Error('Unique violation');
            err.code = 'P2002';
            throw err;
          }
          const row = {
            id: `rp-${state.rps.size + 1}`,
            ...data,
            dataRecorde: new Date(),
          };
          state.rps.set(k, row);
          return row;
        },
        updateMany: async ({ where, data }) => {
          // Procura a linha por id e checa o predicado `valor: { lt: kg }`.
          for (const [k, row] of state.rps) {
            if (row.id !== where.id) continue;
            if (where.valor?.lt !== undefined && !(row.valor < where.valor.lt)) {
              return { count: 0 };
            }
            state.rps.set(k, { ...row, ...data });
            return { count: 1 };
          }
          return { count: 0 };
        },
      },
    },
  },
});

let salvarExecucao;
before(async () => {
  ({ salvarExecucao } = await import('../services/execucao.service.js'));
});

beforeEach(() => {
  state.rps.clear();
  state.beforeCreate = null;
  state.treino.detalhes = {
    tipo: 'musculacao',
    exercicios: [{ nome: 'Supino', realizado: [] }],
  };
});

const userAluno = { userId: 'user-1', role: 'ALUNO' };

function inputComSet(kg, reps) {
  return {
    exercicios: [
      { nome: 'Supino', realizado: [{ kg, reps }] },
    ],
    status: 'CONCLUIDO',
  };
}

describe('salvarExecucao — RP race recovery (PR #10)', () => {
  it('primeiro RP: cria linha e retorna novoRecorde com anterior=null', async () => {
    const { novosRecordes } = await salvarExecucao({
      user: userAluno,
      treinoId: 'treino-1',
      input: inputComSet(80, 10),
    });
    assert.equal(novosRecordes.length, 1);
    assert.equal(novosRecordes[0].valor, 80);
    assert.equal(novosRecordes[0].anterior, null);
  });

  it('valor menor que RP atual: não retorna novoRecorde, não muda DB', async () => {
    state.rps.set('Supino|10', {
      id: 'rp-1', alunoId: 'aluno-1', exercicio: 'Supino',
      metrica: 'kg_x_reps', valor: 100, unidade: 'kg', reps: 10,
      dataRecorde: new Date(),
    });

    const { novosRecordes } = await salvarExecucao({
      user: userAluno,
      treinoId: 'treino-1',
      input: inputComSet(80, 10),
    });
    assert.equal(novosRecordes.length, 0);
    assert.equal(state.rps.get('Supino|10').valor, 100);
  });

  it('valor maior: update in-place (uma linha só) e novoRecorde com anterior', async () => {
    state.rps.set('Supino|10', {
      id: 'rp-1', alunoId: 'aluno-1', exercicio: 'Supino',
      metrica: 'kg_x_reps', valor: 80, unidade: 'kg', reps: 10,
      dataRecorde: new Date('2026-01-01'),
    });

    const { novosRecordes } = await salvarExecucao({
      user: userAluno,
      treinoId: 'treino-1',
      input: inputComSet(90, 10),
    });
    assert.equal(novosRecordes.length, 1);
    assert.equal(novosRecordes[0].valor, 90);
    assert.equal(novosRecordes[0].anterior.valor, 80);
    assert.equal(state.rps.size, 1);
    assert.equal(state.rps.get('Supino|10').valor, 90);
  });

  it('race no create (P2002): relê e cai no update conditional sem crashar', async () => {
    // Cenário: findUnique retorna null, mas entre o findUnique e o create
    // outro POST concorrente já inseriu valor=85. Nosso create dá P2002,
    // service relê (85) e tenta subir pra 90.
    state.beforeCreate = async () => {
      state.rps.set('Supino|10', {
        id: 'rp-concurrent', alunoId: 'aluno-1', exercicio: 'Supino',
        metrica: 'kg_x_reps', valor: 85, unidade: 'kg', reps: 10,
        dataRecorde: new Date('2026-02-01'),
      });
    };

    const { novosRecordes } = await salvarExecucao({
      user: userAluno,
      treinoId: 'treino-1',
      input: inputComSet(90, 10),
    });
    assert.equal(novosRecordes.length, 1);
    assert.equal(novosRecordes[0].valor, 90);
    assert.equal(novosRecordes[0].anterior.valor, 85);
    assert.equal(state.rps.get('Supino|10').valor, 90);
  });

  it('race no update concorrente: updateMany count=0, ninguém regride o RP', async () => {
    // Outro POST já subiu pra 95 antes do nosso updateMany. Predicado
    // `valor < 90` falha (95 não é menor que 90) → count=0 → nenhum
    // novoRecorde retornado, valor permanece 95.
    state.rps.set('Supino|10', {
      id: 'rp-1', alunoId: 'aluno-1', exercicio: 'Supino',
      metrica: 'kg_x_reps', valor: 95, unidade: 'kg', reps: 10,
      dataRecorde: new Date(),
    });

    const { novosRecordes } = await salvarExecucao({
      user: userAluno,
      treinoId: 'treino-1',
      input: inputComSet(90, 10),
    });
    assert.equal(novosRecordes.length, 0);
    assert.equal(state.rps.get('Supino|10').valor, 95);
  });
});
