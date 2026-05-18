import { describe, it, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// PR #22 — testa que listExercicios propaga os novos filtros (dominio,
// tipoMovimento) pro Prisma sem regressão nos filtros antigos.

const state = {
  lastWhere: null,
  rows: [],
};

mock.module('../lib/prisma.js', {
  namedExports: {
    prisma: {
      exercicio: {
        findMany: async (args) => {
          state.lastWhere = args.where;
          return state.rows;
        },
      },
    },
  },
});

let listExercicios;
before(async () => {
  ({ listExercicios } = await import('../services/exercicio.service.js'));
});

beforeEach(() => {
  state.lastWhere = null;
  state.rows = [];
});

describe('listExercicios — filtros do picker BJJ (PR #22)', () => {
  it('sem filtros → where vazio', async () => {
    await listExercicios({});
    assert.deepEqual(state.lastWhere, {});
  });

  it('filtra por dominio JIU_JITSU', async () => {
    await listExercicios({ dominio: 'JIU_JITSU' });
    assert.deepEqual(state.lastWhere, { dominio: 'JIU_JITSU' });
  });

  it('filtra por tipoMovimento isolado', async () => {
    await listExercicios({ tipoMovimento: 'SUBMISSAO' });
    assert.deepEqual(state.lastWhere, { tipoMovimento: 'SUBMISSAO' });
  });

  it('filtros compostos (dominio + tipoMovimento + busca textual)', async () => {
    await listExercicios({
      dominio: 'JIU_JITSU',
      tipoMovimento: 'PASSAGEM',
      q: 'toreando',
    });
    assert.equal(state.lastWhere.dominio, 'JIU_JITSU');
    assert.equal(state.lastWhere.tipoMovimento, 'PASSAGEM');
    assert.deepEqual(state.lastWhere.nome, { contains: 'toreando', mode: 'insensitive' });
  });

  it('compat retroativo: grupo (musculação) continua funcionando', async () => {
    await listExercicios({ grupo: 'PEITO' });
    assert.deepEqual(state.lastWhere, { grupoMuscular: 'PEITO' });
  });

  it('combinando grupo + dominio (caso edge, mas suportado)', async () => {
    await listExercicios({ grupo: 'CARDIO', dominio: 'MOBILIDADE' });
    assert.equal(state.lastWhere.grupoMuscular, 'CARDIO');
    assert.equal(state.lastWhere.dominio, 'MOBILIDADE');
  });
});
