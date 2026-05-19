import { describe, it, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// PR #19 — Sala de Troféus Endurance.
//
// Cobre: detector canônico (buckets 5K/10K/21.1K/42.2K com tolerância
// ±200m), aplicação de RP de pace via salvarExecucao em treino CORRIDA,
// e race recovery lower-is-better (updateMany WHERE valor > novo).

const state = {
  aluno: { id: 'aluno-1', userId: 'user-1' },
  treino: null,
  rps: new Map(),       // key: `${exercicio}|${metrica}` → row
  beforeCreate: null,   // hook pra simular race no create
};

function chavePace(args) {
  // findFirst com where { alunoId, exercicio, metrica, reps: null }
  const k = args.where;
  return `${k.exercicio}|${k.metrica}`;
}

mock.module('../lib/prisma.js', {
  namedExports: {
    prisma: {
      aluno: { findUnique: async () => state.aluno },
      treino: {
        findUnique: async () => state.treino,
        update: async ({ data }) => ({ ...state.treino, ...data }),
      },
      // PR #31 — stubs pra engine de conquistas (queueMicrotask em
      // salvarExecucao dispara avaliarConquistas RP_FIRST/PACE).
      conquistaDesbloqueada: {
        findMany: async () => [],
        createMany: async () => ({ count: 0 }),
      },
      $queryRaw: async () => [],
      recordePessoal: {
        findUnique: async () => null,
        findFirst: async (args) => state.rps.get(chavePace(args)) ?? null,
        count: async () => 0, // engine RP_FIRST chama count
        create: async ({ data }) => {
          if (state.beforeCreate) {
            await state.beforeCreate(data);
            state.beforeCreate = null;
          }
          const k = `${data.exercicio}|${data.metrica}`;
          if (state.rps.has(k)) {
            const err = new Error('Unique violation');
            err.code = 'P2002';
            throw err;
          }
          const row = { id: `rp-${state.rps.size + 1}`, ...data, dataRecorde: new Date() };
          state.rps.set(k, row);
          return row;
        },
        updateMany: async ({ where, data }) => {
          for (const [k, row] of state.rps) {
            if (row.id !== where.id) continue;
            // Predicado `gt: novo` → só atualiza se valor atual > novo.
            if (where.valor?.gt !== undefined && !(row.valor > where.valor.gt)) {
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

let salvarExecucao, detectarDistanciaCanonica;
before(async () => {
  ({ salvarExecucao, detectarDistanciaCanonica } = await import('../services/execucao.service.js'));
});

beforeEach(() => {
  state.rps.clear();
  state.beforeCreate = null;
});

const userAluno = { userId: 'user-1', role: 'ALUNO' };

function treinoCorrida({ distanciaKm, duracaoSeg }) {
  return {
    id: 'treino-1', alunoId: 'aluno-1', professorId: null,
    detalhes: {
      tipo: 'corrida',
      distanciaKm,
      realizado: { distanciaKm, duracaoSeg },
    },
  };
}

describe('detectarDistanciaCanonica — buckets ±200m', () => {
  it('5K dentro do bucket', () => {
    assert.equal(detectarDistanciaCanonica(5.0)?.exercicio, '5K');
    assert.equal(detectarDistanciaCanonica(4.8)?.exercicio, '5K');
    assert.equal(detectarDistanciaCanonica(5.2)?.exercicio, '5K');
  });

  it('4.79 km → fora do bucket de 5K (cap inferior estrito)', () => {
    assert.equal(detectarDistanciaCanonica(4.79), null);
  });

  it('10K, 21.1K, 42.2K identificados corretamente', () => {
    assert.equal(detectarDistanciaCanonica(10.1)?.exercicio, '10K');
    assert.equal(detectarDistanciaCanonica(21.1)?.exercicio, '21.1K');
    assert.equal(detectarDistanciaCanonica(42.195)?.exercicio, '42.2K');
  });

  it('15K (corrida entre 10K e 21K) → null', () => {
    assert.equal(detectarDistanciaCanonica(15.0), null);
  });

  it('valores inválidos → null', () => {
    assert.equal(detectarDistanciaCanonica(0), null);
    assert.equal(detectarDistanciaCanonica(-5), null);
    assert.equal(detectarDistanciaCanonica(NaN), null);
    assert.equal(detectarDistanciaCanonica(undefined), null);
  });
});

describe('salvarExecucao — RP de pace (PR #19)', () => {
  it('primeira corrida de 5K → cria RP com pace em s/km', async () => {
    state.treino = treinoCorrida({ distanciaKm: 5.0, duracaoSeg: 1500 }); // 25min → 5:00/km
    const { novosRecordes } = await salvarExecucao({
      user: userAluno,
      treinoId: 'treino-1',
      input: {
        realizado: { distanciaKm: 5.0, duracaoSeg: 1500 },
        status: 'CONCLUIDO',
      },
    });
    assert.equal(novosRecordes.length, 1);
    assert.equal(novosRecordes[0].exercicio, '5K');
    assert.equal(novosRecordes[0].unidade, 's/km');
    assert.equal(novosRecordes[0].valor, 300); // 1500s / 5km = 300 s/km
    assert.equal(novosRecordes[0].anterior, null);
  });

  it('corrida fora dos buckets canônicos (15K) → NÃO gera RP', async () => {
    state.treino = treinoCorrida({ distanciaKm: 15.0, duracaoSeg: 5400 });
    const { novosRecordes } = await salvarExecucao({
      user: userAluno,
      treinoId: 'treino-1',
      input: { realizado: { distanciaKm: 15.0, duracaoSeg: 5400 } },
    });
    assert.equal(novosRecordes.length, 0);
  });

  it('treino sem realizado preenchido → não gera RP', async () => {
    // Treino com prescrição mas SEM realizado (status=PULADO ou
    // aluno só fechou sem registrar). Service não detecta pace.
    state.treino = treinoCorrida({ distanciaKm: 5.0, duracaoSeg: 1500 });
    state.treino.detalhes.realizado = null;
    const { novosRecordes } = await salvarExecucao({
      user: userAluno,
      treinoId: 'treino-1',
      input: { status: 'PULADO' },
    });
    assert.equal(novosRecordes.length, 0);
  });

  it('pace MELHOR que RP atual → update + retorna anterior', async () => {
    state.rps.set('5K|pace', {
      id: 'rp-1', alunoId: 'aluno-1', exercicio: '5K', metrica: 'pace',
      valor: 320, unidade: 's/km', reps: null,
      dataRecorde: new Date('2026-01-01'),
    });
    state.treino = treinoCorrida({ distanciaKm: 5.0, duracaoSeg: 1450 });
    const { novosRecordes } = await salvarExecucao({
      user: userAluno,
      treinoId: 'treino-1',
      input: { realizado: { distanciaKm: 5.0, duracaoSeg: 1450 } },
    });
    assert.equal(novosRecordes.length, 1);
    assert.equal(novosRecordes[0].valor, 290); // 1450/5
    assert.equal(novosRecordes[0].anterior.valor, 320);
    assert.equal(state.rps.size, 1);
  });

  it('pace PIOR que RP atual → não gera RP, mantém o valor', async () => {
    state.rps.set('5K|pace', {
      id: 'rp-1', alunoId: 'aluno-1', exercicio: '5K', metrica: 'pace',
      valor: 280, unidade: 's/km', reps: null,
      dataRecorde: new Date('2026-01-01'),
    });
    state.treino = treinoCorrida({ distanciaKm: 5.0, duracaoSeg: 1500 });
    const { novosRecordes } = await salvarExecucao({
      user: userAluno,
      treinoId: 'treino-1',
      input: { realizado: { distanciaKm: 5.0, duracaoSeg: 1500 } },
    });
    assert.equal(novosRecordes.length, 0);
    assert.equal(state.rps.get('5K|pace').valor, 280);
  });

  it('race no create (P2002): relê e cai no update conditional', async () => {
    // findFirst inicial retorna null, mas entre o findFirst e o create
    // outro POST concorrente já criou pace=310. O nosso create dá P2002,
    // service relê e tenta subir (na verdade BAIXAR) pra 295.
    state.beforeCreate = async () => {
      state.rps.set('5K|pace', {
        id: 'rp-concurrent', alunoId: 'aluno-1', exercicio: '5K', metrica: 'pace',
        valor: 310, unidade: 's/km', reps: null,
        dataRecorde: new Date('2026-02-01'),
      });
    };
    state.treino = treinoCorrida({ distanciaKm: 5.0, duracaoSeg: 1475 });

    const { novosRecordes } = await salvarExecucao({
      user: userAluno,
      treinoId: 'treino-1',
      input: { realizado: { distanciaKm: 5.0, duracaoSeg: 1475 } },
    });
    assert.equal(novosRecordes.length, 1);
    assert.equal(novosRecordes[0].valor, 295);
    assert.equal(novosRecordes[0].anterior.valor, 310);
  });

  it('race no update concorrente: updateMany count=0 (lower-is-better predicado)', async () => {
    // Outro POST já baixou pra 280 antes do nosso updateMany. Predicado
    // `valor > 295` falha (280 NÃO é maior que 295) → count=0 → nada
    // retornado, valor permanece 280.
    state.rps.set('5K|pace', {
      id: 'rp-1', alunoId: 'aluno-1', exercicio: '5K', metrica: 'pace',
      valor: 280, unidade: 's/km', reps: null,
      dataRecorde: new Date('2026-02-01'),
    });
    state.treino = treinoCorrida({ distanciaKm: 5.0, duracaoSeg: 1475 });
    const { novosRecordes } = await salvarExecucao({
      user: userAluno,
      treinoId: 'treino-1',
      input: { realizado: { distanciaKm: 5.0, duracaoSeg: 1475 } },
    });
    assert.equal(novosRecordes.length, 0);
    assert.equal(state.rps.get('5K|pace').valor, 280);
  });

  it('múltiplas distâncias canônicas no mesmo aluno coexistem (5K + 10K)', async () => {
    state.rps.set('5K|pace', {
      id: 'rp-1', alunoId: 'aluno-1', exercicio: '5K', metrica: 'pace',
      valor: 290, unidade: 's/km', reps: null,
      dataRecorde: new Date('2026-01-01'),
    });
    state.treino = treinoCorrida({ distanciaKm: 10.0, duracaoSeg: 3300 });
    const { novosRecordes } = await salvarExecucao({
      user: userAluno,
      treinoId: 'treino-1',
      input: { realizado: { distanciaKm: 10.0, duracaoSeg: 3300 } },
    });
    assert.equal(novosRecordes.length, 1);
    assert.equal(novosRecordes[0].exercicio, '10K');
    assert.equal(state.rps.size, 2);
  });
});
