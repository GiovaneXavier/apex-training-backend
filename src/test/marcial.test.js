import { describe, it, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import { promocaoCreateSchema } from '../schemas/marcial.schemas.js';

// PR #24 — Jornada Marcial: schema + service mockando prisma.

// ─── Testes do schema (isolados, sem mock) ──────────────────────────

describe('promocaoCreateSchema — validação (PR #24)', () => {
  it('aceita payload mínimo (faixa + dataPromocao)', () => {
    const out = promocaoCreateSchema.parse({
      faixa: 'AZUL',
      dataPromocao: new Date().toISOString(),
    });
    assert.equal(out.grauNum, 0); // default
    assert.equal(out.faixa, 'AZUL');
  });

  it('aceita payload completo (prof registrando promoção do aluno)', () => {
    const out = promocaoCreateSchema.parse({
      alunoId: 'aluno-1',
      faixa: 'ROXA',
      grauNum: 2,
      dataPromocao: '2025-08-01T10:00:00.000Z',
      instrutorNome: 'Mestre Royler Gracie',
      observacao: 'Promovido após o teste de faixa.',
    });
    assert.equal(out.grauNum, 2);
    assert.equal(out.instrutorNome, 'Mestre Royler Gracie');
  });

  it('rejeita faixa inválida', () => {
    assert.throws(() =>
      promocaoCreateSchema.parse({ faixa: 'AMARELA', dataPromocao: new Date().toISOString() }),
    );
  });

  it('rejeita grauNum fora de [0,4]', () => {
    const base = { faixa: 'AZUL', dataPromocao: new Date().toISOString() };
    assert.throws(() => promocaoCreateSchema.parse({ ...base, grauNum: -1 }));
    assert.throws(() => promocaoCreateSchema.parse({ ...base, grauNum: 5 }));
    assert.throws(() => promocaoCreateSchema.parse({ ...base, grauNum: 2.5 }));
  });

  it('aceita dataPromocao no passado (registro retroativo)', () => {
    const dataAntiga = new Date('2020-06-15T10:00:00.000Z').toISOString();
    assert.doesNotThrow(() =>
      promocaoCreateSchema.parse({ faixa: 'AZUL', dataPromocao: dataAntiga }),
    );
  });

  it('rejeita dataPromocao > 1 dia no futuro', () => {
    const futuro = new Date(Date.now() + 2 * 86_400_000).toISOString();
    assert.throws(() =>
      promocaoCreateSchema.parse({ faixa: 'AZUL', dataPromocao: futuro }),
    );
  });

  it('rejeita instrutorNome > 120 chars', () => {
    assert.throws(() =>
      promocaoCreateSchema.parse({
        faixa: 'AZUL',
        dataPromocao: new Date().toISOString(),
        instrutorNome: 'A'.repeat(121),
      }),
    );
  });
});

// ─── Testes do service (mock prisma) ────────────────────────────────

const state = {
  aluno: { id: 'aluno-1', userId: 'user-aluno-1' },
  promocoes: [], // mais recente PRIMEIRO (orderBy desc)
  matTimeRows: [{ mat_time_seg: 0 }],
  lastQueryParams: null,
};

mock.module('../lib/prisma.js', {
  namedExports: {
    prisma: {
      aluno: { findUnique: async () => state.aluno },
      professor: { findUnique: async () => null },
      nutricionista: { findUnique: async () => null },
      vinculoProfessor: { findUnique: async () => null },
      vinculoNutricionista: { findUnique: async () => null },
      evolucaoMarcial: {
        findFirst: async () => state.promocoes[0] ?? null,
        findMany: async () => state.promocoes,
        findUnique: async ({ where }) =>
          state.promocoes.find((p) => p.id === where.id) ?? null,
        create: async ({ data }) => {
          const novo = { id: `prom-${state.promocoes.length + 1}`, ...data, criadoEm: new Date() };
          state.promocoes.unshift(novo);
          return novo;
        },
        delete: async ({ where }) => {
          state.promocoes = state.promocoes.filter((p) => p.id !== where.id);
          return { id: where.id };
        },
      },
      $queryRaw: async () => state.matTimeRows,
    },
  },
});

let getJornadaMarcial, getFaixaAtual, registrarPromocao;
before(async () => {
  ({ getJornadaMarcial, getFaixaAtual, registrarPromocao } = await import(
    '../services/marcial.service.js'
  ));
});

beforeEach(() => {
  state.promocoes = [];
  state.matTimeRows = [{ mat_time_seg: 0 }];
});

const userAluno = { userId: 'user-aluno-1', role: 'ALUNO' };

describe('getFaixaAtual — última promoção (PR #24)', () => {
  it('sem promoções → null', async () => {
    const out = await getFaixaAtual({ user: userAluno });
    assert.equal(out, null);
  });

  it('com promoções → retorna a mais recente (orderBy desc)', async () => {
    state.promocoes = [
      { id: 'p2', faixa: 'AZUL', grauNum: 1, dataPromocao: new Date('2026-02-01') },
      { id: 'p1', faixa: 'BRANCA', grauNum: 4, dataPromocao: new Date('2024-08-01') },
    ];
    const out = await getFaixaAtual({ user: userAluno });
    assert.equal(out.id, 'p2');
    assert.equal(out.faixa, 'AZUL');
  });
});

describe('getJornadaMarcial — agregação (PR #24)', () => {
  it('atleta sem promoção → objeto completo com null + 0%', async () => {
    const out = await getJornadaMarcial({ user: userAluno });
    assert.equal(out.faixaAtual, null);
    assert.equal(out.matTimeNaFaixaSeg, 0);
    assert.equal(out.proximaFaixa, null);
    assert.equal(out.metaSegundos, null);
    assert.equal(out.progressoPct, 0);
  });

  it('BRANCA com 0h de matTime → meta=200h*3600, progresso=0%', async () => {
    state.promocoes = [
      { id: 'p1', faixa: 'BRANCA', grauNum: 0, dataPromocao: new Date('2026-01-01') },
    ];
    const out = await getJornadaMarcial({ user: userAluno });
    assert.equal(out.faixaAtual.faixa, 'BRANCA');
    assert.equal(out.proximaFaixa, 'AZUL');
    assert.equal(out.metaSegundos, 200 * 3600);
    assert.equal(out.progressoPct, 0);
  });

  it('AZUL com 100h na faixa → progresso = 100/400 = 25%', async () => {
    state.promocoes = [
      { id: 'p1', faixa: 'AZUL', grauNum: 2, dataPromocao: new Date('2025-06-01') },
    ];
    state.matTimeRows = [{ mat_time_seg: 100 * 3600 }]; // 360_000s
    const out = await getJornadaMarcial({ user: userAluno });
    assert.equal(out.matTimeNaFaixaSeg, 360_000);
    assert.equal(out.metaSegundos, 400 * 3600);
    assert.equal(out.progressoPct, 25);
  });

  it('atleta ultrapassa meta → clampa em 100%', async () => {
    state.promocoes = [
      { id: 'p1', faixa: 'BRANCA', grauNum: 4, dataPromocao: new Date('2024-01-01') },
    ];
    state.matTimeRows = [{ mat_time_seg: 999 * 3600 }];
    const out = await getJornadaMarcial({ user: userAluno });
    assert.equal(out.progressoPct, 100);
  });

  it('PRETA → sem proxima nem meta (endgame)', async () => {
    state.promocoes = [
      { id: 'p1', faixa: 'PRETA', grauNum: 0, dataPromocao: new Date('2024-01-01') },
    ];
    state.matTimeRows = [{ mat_time_seg: 50 * 3600 }];
    const out = await getJornadaMarcial({ user: userAluno });
    assert.equal(out.faixaAtual.faixa, 'PRETA');
    assert.equal(out.proximaFaixa, null);
    assert.equal(out.metaSegundos, null);
    assert.equal(out.progressoPct, 0); // não exibe barra
    assert.equal(out.matTimeNaFaixaSeg, 180_000); // mas mostra tempo
  });

  it('arredonda progressoPct (não vira 33.33333...)', async () => {
    state.promocoes = [
      { id: 'p1', faixa: 'AZUL', grauNum: 0, dataPromocao: new Date('2025-06-01') },
    ];
    // 132/400 = 33%
    state.matTimeRows = [{ mat_time_seg: 132 * 3600 }];
    const out = await getJornadaMarcial({ user: userAluno });
    assert.equal(out.progressoPct, 33);
  });
});

describe('registrarPromocao — ACL', () => {
  it('NUTRICIONISTA tentando registrar → 403', async () => {
    await assert.rejects(
      registrarPromocao({
        user: { userId: 'user-nutri-1', role: 'NUTRICIONISTA' },
        input: { faixa: 'AZUL', dataPromocao: new Date().toISOString() },
      }),
      (err) => err?.status === 403,
    );
  });

  it('ALUNO registra promoção própria', async () => {
    const out = await registrarPromocao({
      user: userAluno,
      input: {
        faixa: 'AZUL',
        grauNum: 0,
        dataPromocao: new Date('2026-01-15').toISOString(),
        instrutorNome: 'Mestre X',
      },
    });
    assert.equal(out.faixa, 'AZUL');
    assert.equal(out.alunoId, 'aluno-1');
  });
});
