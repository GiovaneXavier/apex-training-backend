import { describe, it, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// PR #31 — Engine de conquistas. Mock prisma + firePush.

const state = {
  desbloqueadas: [],
  inserted: [],
  recordeCountByMod: new Map(),
  aluno: null,
  // Pra trigger STREAK: rows que o $queryRaw devolve.
  streakRows: [],
};

mock.module('../lib/prisma.js', {
  namedExports: {
    prisma: {
      conquistaDesbloqueada: {
        findMany: async ({ where }) =>
          state.desbloqueadas.filter(
            (d) => d.alunoId === where.alunoId && where.codigo.in.includes(d.codigo),
          ),
        createMany: async ({ data }) => {
          // Simula skipDuplicates: rejeita repetidos.
          let inserted = 0;
          for (const row of data) {
            const exists = state.desbloqueadas.some(
              (d) => d.alunoId === row.alunoId && d.codigo === row.codigo,
            );
            if (!exists) {
              state.desbloqueadas.push(row);
              state.inserted.push(row);
              inserted++;
            }
          }
          return { count: inserted };
        },
      },
      aluno: {
        findUnique: async ({ where }) =>
          state.aluno && where.id === state.aluno.id ? state.aluno : null,
      },
      recordePessoal: {
        count: async ({ where }) =>
          state.recordeCountByMod.get(where.modalidade) ?? 0,
      },
      $queryRaw: async () => state.streakRows,
    },
  },
});

let engine;
const pushCalls = [];

before(async () => {
  engine = await import('../lib/conquistasEngine.js');
  engine.__setFirePushForTests((args) => { pushCalls.push(args); });
});

beforeEach(() => {
  state.desbloqueadas = [];
  state.inserted = [];
  state.recordeCountByMod = new Map();
  state.aluno = { id: 'aluno-1', userId: 'user-aluno-1' };
  state.streakRows = [];
  pushCalls.length = 0;
});

function semanasAtrasISO(n) {
  const d = new Date();
  const dia = d.getUTCDay();
  const diff = (dia - 1 + 7) % 7;
  const seg = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  seg.setUTCDate(seg.getUTCDate() - diff - n * 7);
  return seg.toISOString().slice(0, 10);
}

// ─── STREAK trigger ─────────────────────────────────────────────────

describe('avaliarConquistas — trigger STREAK', () => {
  it('aluno com 4 semanas seguidas → desbloqueia STREAK_2 + STREAK_4', async () => {
    // Gera 4 semanas válidas (cada uma com 3 atividades).
    state.streakRows = [
      { semana: semanasAtrasISO(3), atividades: 3 },
      { semana: semanasAtrasISO(2), atividades: 3 },
      { semana: semanasAtrasISO(1), atividades: 3 },
      { semana: semanasAtrasISO(0), atividades: 3 },
    ];
    const novos = await engine.avaliarConquistas({
      alunoId: 'aluno-1', trigger: 'STREAK',
    });
    const codigos = novos.map((n) => n.codigo);
    assert.ok(codigos.includes('STREAK_2_SEMANAS'));
    assert.ok(codigos.includes('STREAK_4_SEMANAS'));
    assert.equal(codigos.includes('STREAK_12_SEMANAS'), false);
  });

  it('idempotência: segunda chamada NÃO duplica (já desbloqueado)', async () => {
    state.streakRows = [
      { semana: semanasAtrasISO(1), atividades: 3 },
      { semana: semanasAtrasISO(0), atividades: 3 },
    ];
    await engine.avaliarConquistas({ alunoId: 'aluno-1', trigger: 'STREAK' });
    const inserted1 = state.inserted.length;
    pushCalls.length = 0;

    const novos2 = await engine.avaliarConquistas({ alunoId: 'aluno-1', trigger: 'STREAK' });
    assert.equal(novos2.length, 0);
    assert.equal(state.inserted.length, inserted1, 'sem inserts adicionais');
    assert.equal(pushCalls.length, 0, 'sem push duplicado');
  });

  it('dispatch push 1x por novo desbloqueio', async () => {
    state.streakRows = [
      { semana: semanasAtrasISO(1), atividades: 3 },
      { semana: semanasAtrasISO(0), atividades: 3 },
    ];
    await engine.avaliarConquistas({ alunoId: 'aluno-1', trigger: 'STREAK' });
    assert.equal(pushCalls.length, 1);
    assert.equal(pushCalls[0].userId, 'user-aluno-1');
    assert.ok(pushCalls[0].payload.title.includes('Conquista'));
  });
});

// ─── RP_FIRST trigger ──────────────────────────────────────────────

describe('avaliarConquistas — trigger RP_FIRST', () => {
  it('1º RP de musculação → desbloqueia PRIMEIRO_RP_MUSCULACAO', async () => {
    state.recordeCountByMod.set('MUSCULACAO', 1);
    const novos = await engine.avaliarConquistas({
      alunoId: 'aluno-1',
      trigger: 'RP_FIRST',
      contexto: { novosRecordes: [{ exercicio: 'Supino', valor: 100 }] },
    });
    assert.equal(novos.length, 1);
    assert.equal(novos[0].codigo, 'PRIMEIRO_RP_MUSCULACAO');
  });

  it('2º RP da MESMA modalidade NÃO redispara', async () => {
    state.recordeCountByMod.set('MUSCULACAO', 2);
    const novos = await engine.avaliarConquistas({
      alunoId: 'aluno-1',
      trigger: 'RP_FIRST',
      contexto: { novosRecordes: [{ exercicio: 'Agachamento' }] },
    });
    assert.equal(novos.length, 0);
  });

  it('contexto sem novosRecordes → no-op', async () => {
    state.recordeCountByMod.set('MUSCULACAO', 1);
    const novos = await engine.avaliarConquistas({
      alunoId: 'aluno-1',
      trigger: 'RP_FIRST',
      contexto: {},
    });
    assert.equal(novos.length, 0);
  });
});

// ─── PACE_THRESHOLD trigger ────────────────────────────────────────

describe('avaliarConquistas — trigger PACE_THRESHOLD', () => {
  it('5k em 290 seg/km (≤ 300) → desbloqueia RP_PACE_5K_SUB25', async () => {
    const novos = await engine.avaliarConquistas({
      alunoId: 'aluno-1',
      trigger: 'PACE_THRESHOLD',
      contexto: {
        novosRecordes: [{ exercicio: '5k', valor: 290 }],
      },
    });
    assert.equal(novos.length, 1);
    assert.equal(novos[0].codigo, 'RP_PACE_5K_SUB25');
  });

  it('5k em 310 seg/km (acima de 300) → NÃO desbloqueia', async () => {
    const novos = await engine.avaliarConquistas({
      alunoId: 'aluno-1',
      trigger: 'PACE_THRESHOLD',
      contexto: { novosRecordes: [{ exercicio: '5k', valor: 310 }] },
    });
    assert.equal(novos.length, 0);
  });

  it('10k em 320 seg/km → desbloqueia 10K_SUB55', async () => {
    const novos = await engine.avaliarConquistas({
      alunoId: 'aluno-1',
      trigger: 'PACE_THRESHOLD',
      contexto: { novosRecordes: [{ exercicio: '10k', valor: 320 }] },
    });
    assert.equal(novos.length, 1);
    assert.equal(novos[0].codigo, 'RP_PACE_10K_SUB55');
  });
});

// ─── FAIXA_PROMOCAO trigger ────────────────────────────────────────

describe('avaliarConquistas — trigger FAIXA_PROMOCAO', () => {
  it('promoção AZUL → desbloqueia PRIMEIRA_PROMOCAO_BJJ (faixaAlvo null), NÃO desbloqueia FAIXA_PRETA', async () => {
    const novos = await engine.avaliarConquistas({
      alunoId: 'aluno-1',
      trigger: 'FAIXA_PROMOCAO',
      contexto: { faixa: 'AZUL' },
    });
    const codigos = novos.map((n) => n.codigo);
    assert.ok(codigos.includes('PRIMEIRA_PROMOCAO_BJJ'));
    assert.equal(codigos.includes('FAIXA_PRETA_BJJ'), false);
  });

  it('promoção PRETA → desbloqueia AMBAS (primeira + preta) se ainda não desbloqueadas', async () => {
    const novos = await engine.avaliarConquistas({
      alunoId: 'aluno-1',
      trigger: 'FAIXA_PROMOCAO',
      contexto: { faixa: 'PRETA' },
    });
    const codigos = novos.map((n) => n.codigo);
    assert.ok(codigos.includes('PRIMEIRA_PROMOCAO_BJJ'));
    assert.ok(codigos.includes('FAIXA_PRETA_BJJ'));
  });
});

// ─── Fail-soft ─────────────────────────────────────────────────────

describe('avaliarConquistas — fail-soft', () => {
  it('alunoId ausente → retorna [] sem crash', async () => {
    const out = await engine.avaliarConquistas({ trigger: 'STREAK' });
    assert.deepEqual(out, []);
  });

  it('trigger desconhecido → retorna [] sem crash', async () => {
    const out = await engine.avaliarConquistas({
      alunoId: 'aluno-1', trigger: 'INEXISTENTE',
    });
    assert.deepEqual(out, []);
  });
});
