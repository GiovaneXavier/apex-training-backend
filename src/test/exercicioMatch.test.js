import { describe, it, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// PR #30 — lib de fuzzy match. Mock prisma com cenários reais de retorno.

const state = {
  queryRows: [],
  findManyRows: [],
  throwOnQuery: null,
};

mock.module('../lib/prisma.js', {
  namedExports: {
    prisma: {
      $queryRaw: async () => {
        if (state.throwOnQuery) throw state.throwOnQuery;
        return state.queryRows;
      },
      exercicio: {
        findMany: async () => state.findManyRows,
      },
    },
  },
});

let mod;

before(async () => {
  mod = await import('../lib/exercicioMatch.js');
});

beforeEach(() => {
  state.queryRows = [];
  state.findManyRows = [];
  state.throwOnQuery = null;
});

// ─── classify ───────────────────────────────────────────────────────

describe('classify — semáforo de confiança', () => {
  it('score ≥ 0.9 → verde', () => {
    const out = mod.__internal.classify({
      nomeLlm: 'Supino Reto', exercicioId: 'ex-1', nomeCanonico: 'Supino Reto',
      similarityScore: 0.95,
    });
    assert.equal(out.confianca, 'verde');
  });

  it('0.6 ≤ score < 0.9 → laranja', () => {
    const out = mod.__internal.classify({
      nomeLlm: 'Supino Inclinado Halteres',
      exercicioId: 'ex-2', nomeCanonico: 'Supino Inclinado com Halteres',
      similarityScore: 0.75,
    });
    assert.equal(out.confianca, 'laranja');
  });

  it('score < 0.6 → vermelho + exercicioId nullificado', () => {
    const out = mod.__internal.classify({
      nomeLlm: 'Exotic Movement',
      exercicioId: 'ex-x', nomeCanonico: 'Algo',
      similarityScore: 0.4,
    });
    assert.equal(out.confianca, 'vermelho');
    assert.equal(out.exercicioId, null);
  });

  it('sem match (exercicioId null) → vermelho independente do score', () => {
    const out = mod.__internal.classify({
      nomeLlm: 'X', exercicioId: null, nomeCanonico: null, similarityScore: 0,
    });
    assert.equal(out.confianca, 'vermelho');
  });
});

// ─── matchExerciciosBatch — happy path ──────────────────────────────

describe('matchExerciciosBatch — query agregada via UNNEST + LATERAL', () => {
  it('input vazio → output vazio', async () => {
    const out = await mod.matchExerciciosBatch([]);
    assert.deepEqual(out, []);
  });

  it('input só com strings inválidas → todos vermelho null', async () => {
    state.queryRows = [];
    const out = await mod.matchExerciciosBatch(['', '   ', null]);
    assert.equal(out.length, 3);
    for (const r of out) assert.equal(r.confianca, 'vermelho');
  });

  it('mix verde + laranja + vermelho preserva ordem do input', async () => {
    state.queryRows = [
      { nomeLlm: 'Supino Reto', exercicioId: 'e-supino', nomeCanonico: 'Supino Reto', similarityScore: 0.98 },
      { nomeLlm: 'Agachamento Búlgaro', exercicioId: 'e-buga', nomeCanonico: 'Agachamento Búlgaro Halter', similarityScore: 0.72 },
      { nomeLlm: 'Movimento Fantasma', exercicioId: null, nomeCanonico: null, similarityScore: null },
    ];
    const out = await mod.matchExerciciosBatch([
      'Supino Reto', 'Agachamento Búlgaro', 'Movimento Fantasma',
    ]);
    assert.equal(out[0].confianca, 'verde');
    assert.equal(out[0].exercicioId, 'e-supino');
    assert.equal(out[1].confianca, 'laranja');
    assert.ok(out[1].similarityScore > 0.6 && out[1].similarityScore < 0.9);
    assert.equal(out[2].confianca, 'vermelho');
    assert.equal(out[2].exercicioId, null);
  });

  it('input com repetições devolve N saídas com mesmo match', async () => {
    state.queryRows = [
      { nomeLlm: 'Supino', exercicioId: 'e1', nomeCanonico: 'Supino Reto', similarityScore: 0.92 },
    ];
    const out = await mod.matchExerciciosBatch(['Supino', 'Supino', 'Supino']);
    assert.equal(out.length, 3);
    assert.equal(out[0].exercicioId, 'e1');
    assert.equal(out[1].exercicioId, 'e1');
    assert.equal(out[2].exercicioId, 'e1');
  });
});

// ─── Fallback ILIKE ─────────────────────────────────────────────────

describe('matchExerciciosBatch — fallback ILIKE quando pg_trgm indisponível', () => {
  it('erro "function similarity does not exist" → degraded ILIKE', async () => {
    state.throwOnQuery = new Error('function similarity(text, text) does not exist');
    state.findManyRows = [{ id: 'e-supino', nome: 'Supino Reto Barra' }];

    const out = await mod.matchExerciciosBatch(['Supino Reto']);
    assert.equal(out[0].exercicioId, 'e-supino');
    assert.equal(out[0].confianca, 'laranja');
    assert.equal(out[0].similarityScore, 0.5, 'score artificial 0.5 no fallback');
  });

  it('ILIKE sem candidato → vermelho null', async () => {
    state.throwOnQuery = new Error('pg_trgm extension is not installed');
    state.findManyRows = [];

    const out = await mod.matchExerciciosBatch(['Exotic Carry']);
    assert.equal(out[0].confianca, 'vermelho');
    assert.equal(out[0].exercicioId, null);
  });

  it('erro NÃO relacionado a pg_trgm → propaga (não silencia)', async () => {
    state.throwOnQuery = new Error('connection refused');
    await assert.rejects(
      mod.matchExerciciosBatch(['Supino']),
      (e) => /connection refused/.test(e.message),
    );
  });
});

// ─── Detecção pg_trgm missing ──────────────────────────────────────

describe('isPgTrgmMissing — heurística de detecção', () => {
  it('reconhece "function similarity does not exist"', () => {
    const e = new Error('function similarity(text, text) does not exist');
    assert.equal(mod.__internal.isPgTrgmMissing(e), true);
  });
  it('reconhece menção a pg_trgm', () => {
    const e = new Error('pg_trgm extension not loaded');
    assert.equal(mod.__internal.isPgTrgmMissing(e), true);
  });
  it('NÃO confunde erro genérico de DB', () => {
    const e = new Error('connection refused');
    assert.equal(mod.__internal.isPgTrgmMissing(e), false);
  });
});
