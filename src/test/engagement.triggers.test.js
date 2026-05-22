import { describe, it, before, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// PR #27 — testes E2E dos 3 gatilhos plugados nos services.
// Mock prisma + dispatch. Confirma:
//   - userId correto resolvido (nutri→aluno, prof→aluno, aluno→self).
//   - trigger name correto pro audit.
//   - payload com URL/tag certos.
//   - fire-and-forget: service retorna ANTES do dispatch.

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@localhost:5432/test';

const state = {
  aluno: null,
  nutri: null,
  professor: null,
  vinculoNutri: null,
  vinculoProf: null,
  treinoOrigem: null,
  planoCriado: null,
  treinoCriado: null,
  treinoUpdated: null,
  rps: new Map(), // chave estável → recorde
};

mock.module('../lib/prisma.js', {
  namedExports: {
    prisma: {
      aluno: {
        findUnique: async ({ where, select }) => {
          if (!state.aluno) return null;
          if (where.id && where.id !== state.aluno.id) return null;
          if (where.userId && where.userId !== state.aluno.userId) return null;
          if (select?.userId && Object.keys(select).length === 1) {
            return { userId: state.aluno.userId };
          }
          return state.aluno;
        },
      },
      nutricionista: { findUnique: async () => state.nutri },
      professor: { findUnique: async () => state.professor },
      vinculoNutricionista: { findUnique: async () => state.vinculoNutri },
      vinculoProfessor: { findUnique: async () => state.vinculoProf },
      planoAlimentar: {
        updateMany: async () => ({ count: 0 }),
        create: async ({ data }) => {
          state.planoCriado = { id: 'plano-1', ...data, criadoEm: new Date() };
          return state.planoCriado;
        },
      },
      treino: {
        findUnique: async ({ where }) =>
          state.treinoOrigem && where.id === state.treinoOrigem.id ? state.treinoOrigem : null,
        create: async ({ data }) => {
          state.treinoCriado = { id: 'treino-clone-1', ...data, criadoEm: new Date() };
          return state.treinoCriado;
        },
        update: async ({ data }) => {
          state.treinoUpdated = { id: state.treinoOrigem?.id, ...state.treinoOrigem, ...data };
          return state.treinoUpdated;
        },
      },
      recordePessoal: {
        findUnique: async ({ where }) => {
          const k = JSON.stringify(where.RecordePessoal_ativo_unq);
          return state.rps.get(k) || null;
        },
        create: async ({ data }) => {
          const k = JSON.stringify({
            alunoId: data.alunoId, exercicio: data.exercicio, metrica: data.metrica, reps: data.reps,
          });
          const rec = { id: `rp-${state.rps.size + 1}`, ...data, dataRecorde: new Date() };
          state.rps.set(k, rec);
          return rec;
        },
        updateMany: async () => ({ count: 0 }),
      },
      $transaction: async (ops) => Promise.all(ops.map((o) => o)),
    },
  },
});

// Captura do dispatch — substitui o real via test hook do pushTriggers.
let dispatchCalls = [];

let triggers;
let plano;
let treino;
let execucao;

before(async () => {
  triggers = await import('../lib/pushTriggers.js');
  triggers.__setDispatchForTests(async (args) => {
    dispatchCalls.push(args);
    return { sent: 1, dead: 0, failed: 0 };
  });

  plano = await import('../services/plano.service.js');
  treino = await import('../services/treino.service.js');
  execucao = await import('../services/execucao.service.js');
});

function flushMicrotasks() {
  return new Promise((r) => setImmediate(r));
}

beforeEach(() => {
  dispatchCalls = [];
  state.aluno = { id: 'aluno-1', userId: 'user-aluno-1' };
  state.nutri = { id: 'nutri-1', userId: 'user-nutri-1' };
  state.professor = { id: 'prof-1', userId: 'user-prof-1' };
  state.vinculoNutri = {
    id: 'vn-1', alunoId: 'aluno-1', nutricionistaId: 'nutri-1', aceitoPeloAluno: true,
  };
  state.vinculoProf = { id: 'vp-1', alunoId: 'aluno-1', professorId: 'prof-1' };
  state.treinoOrigem = {
    id: 'treino-origem-1',
    alunoId: 'aluno-1',
    professorId: 'prof-1',
    rotinaId: null,
    modalidade: 'MUSCULACAO',
    titulo: 'Treino A',
    detalhes: { tipo: 'musculacao', exercicios: [{ nome: 'Supino', realizado: [] }] },
  };
  state.planoCriado = null;
  state.treinoCriado = null;
  state.treinoUpdated = null;
  state.rps = new Map();
});

afterEach(() => {
  // Mantém o mock global de dispatch entre testes.
});

// Silencia console.log do audit trail durante os testes.
const realLog = console.log;
before(() => { console.log = () => {}; });
afterEach(() => { console.log = () => {}; });

describe('Gatilho da Nutrição (plano.service.createPlano)', () => {
  it('NUTRI cria plano → push vai pro userId do ALUNO', async () => {
    const result = await plano.createPlano({
      user: { userId: 'user-nutri-1', role: 'NUTRICIONISTA' },
      input: { alunoId: 'aluno-1', pdfUrl: 'https://x/p.pdf' },
    });
    assert.equal(result.id, 'plano-1');

    // Fire-and-forget: createPlano já retornou. Drain microtasks.
    await flushMicrotasks();

    assert.equal(dispatchCalls.length, 1);
    assert.equal(dispatchCalls[0].userId, 'user-aluno-1', 'destino = aluno, NÃO nutri');
    assert.equal(dispatchCalls[0].payload.url, '/aluno/perfil');
    assert.equal(dispatchCalls[0].payload.tag, 'novo-plano-alimentar');
  });

  it('falha no push NÃO derruba o createPlano', async () => {
    triggers.__setDispatchForTests(async () => { throw new Error('push-down'); });
    const result = await plano.createPlano({
      user: { userId: 'user-nutri-1', role: 'NUTRICIONISTA' },
      input: { alunoId: 'aluno-1', pdfUrl: 'https://x/p.pdf' },
    });
    assert.equal(result.id, 'plano-1', 'plano foi criado mesmo com push falho');
    await flushMicrotasks();
    // Repõe mock OK pros próximos testes
    triggers.__setDispatchForTests(async (args) => {
      dispatchCalls.push(args);
      return { sent: 1, dead: 0, failed: 0 };
    });
  });
});

describe('Gatilho da Prescrição (treino.service.clonarTreino)', () => {
  it('PROFESSOR clona → push vai pro userId do ALUNO alvo', async () => {
    const novo = await treino.clonarTreino({
      user: { userId: 'user-prof-1', role: 'PROFESSOR' },
      treinoId: 'treino-origem-1',
      dataAlvo: '2026-06-01T10:00:00Z',
    });
    assert.equal(novo.id, 'treino-clone-1');

    await flushMicrotasks();

    assert.equal(dispatchCalls.length, 1);
    assert.equal(dispatchCalls[0].userId, 'user-aluno-1', 'destino = aluno alvo, NÃO professor');
    assert.equal(dispatchCalls[0].payload.url, '/aluno/dashboard');
    assert.equal(dispatchCalls[0].payload.tag, 'novo-treino');
  });
});

describe('Gatilho da Glória (execucao.service — anti-flood)', () => {
  it('1 RP novo → 1 push singular com nome do exercício', async () => {
    await execucao.salvarExecucao({
      user: { userId: 'user-aluno-1', role: 'ALUNO' },
      treinoId: 'treino-origem-1',
      input: {
        exercicios: [{ nome: 'Supino', realizado: [{ kg: 100, reps: 5 }] }],
        status: 'CONCLUIDO',
      },
    });

    await flushMicrotasks();

    assert.equal(dispatchCalls.length, 1, 'exatamente 1 push, não 1 por RP');
    assert.equal(dispatchCalls[0].userId, 'user-aluno-1');
    assert.ok(dispatchCalls[0].payload.title.includes('Novo Recorde'));
    assert.ok(dispatchCalls[0].payload.body.includes('Supino'), 'body cita exercício específico');
    assert.equal(dispatchCalls[0].payload.url, '/aluno/rps');
  });

  it('3 RPs no mesmo treino → 1 push AGREGADO (não 3 pushes)', async () => {
    // Sobrescreve a prescrição pra ter os 3 exercícios autorizados.
    state.treinoOrigem.detalhes = {
      tipo: 'musculacao',
      exercicios: [
        { nome: 'Supino', realizado: [] },
        { nome: 'Agachamento', realizado: [] },
        { nome: 'Terra', realizado: [] },
      ],
    };
    await execucao.salvarExecucao({
      user: { userId: 'user-aluno-1', role: 'ALUNO' },
      treinoId: 'treino-origem-1',
      input: {
        exercicios: [
          { nome: 'Supino', realizado: [{ kg: 100, reps: 5 }] },
          { nome: 'Agachamento', realizado: [{ kg: 140, reps: 5 }] },
          { nome: 'Terra', realizado: [{ kg: 180, reps: 3 }] },
        ],
        status: 'CONCLUIDO',
      },
    });

    await flushMicrotasks();

    assert.equal(dispatchCalls.length, 1, 'anti-flood: 1 push agregado pra N RPs');
    assert.ok(dispatchCalls[0].payload.title.includes('3 novos PRs'));
    assert.ok(
      !dispatchCalls[0].payload.body.includes('Supino'),
      'agregado não nomeia exercício específico',
    );
  });

  it('execução sem RPs → ZERO pushes', async () => {
    // RP já existe maior — nada novo.
    const k = JSON.stringify({
      alunoId: 'aluno-1', exercicio: 'Supino', metrica: 'kg_x_reps', reps: 5,
    });
    state.rps.set(k, {
      id: 'rp-pre', alunoId: 'aluno-1', exercicio: 'Supino',
      metrica: 'kg_x_reps', valor: 200, reps: 5, dataRecorde: new Date(),
    });

    await execucao.salvarExecucao({
      user: { userId: 'user-aluno-1', role: 'ALUNO' },
      treinoId: 'treino-origem-1',
      input: {
        exercicios: [{ nome: 'Supino', realizado: [{ kg: 100, reps: 5 }] }],
        status: 'CONCLUIDO',
      },
    });

    await flushMicrotasks();
    assert.equal(dispatchCalls.length, 0, 'sem RP novo = sem push');
  });
});

// console.log já foi sobrescrito por afterEach; realLog preservado.
// Não há `after` global no scope toplevel de node:test — restauração
// final fica pra GC do processo.
void realLog;
