import { describe, it, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// PR #17 — testes do shaping de alertas. A CTE em si depende do Postgres
// pra rodar de verdade (datas dinâmicas, date_trunc, ROW_NUMBER); aqui
// mockamos $queryRaw devolvendo rows representativas e validamos:
//   1. mapeamento row → Alerta (severidade, detalhe humano)
//   2. preservação de ordem (severidade asc, quando desc)
//   3. acesso por role (apenas PROFESSOR)
//   4. 404 quando o perfil de professor não existe

const state = {
  prof: null,
  rows: [],
};

mock.module('../lib/prisma.js', {
  namedExports: {
    prisma: {
      professor: {
        findUnique: async () => state.prof,
      },
      $queryRaw: async () => state.rows,
    },
  },
});

let listAlertasProf;
before(async () => {
  ({ listAlertasProf } = await import('../services/coach.service.js'));
});

beforeEach(() => {
  state.prof = { id: 'prof-1', userId: 'user-prof-1' };
  state.rows = [];
});

const userProf = { userId: 'user-prof-1', role: 'PROFESSOR' };

function daysAgo(n) {
  return new Date(Date.now() - n * 86_400_000);
}

describe('listAlertasProf — auth (PR #17)', () => {
  it('ALUNO → 403', async () => {
    await assert.rejects(
      listAlertasProf({ user: { userId: 'x', role: 'ALUNO' } }),
      (err) => err?.status === 403,
    );
  });

  it('NUTRICIONISTA → 403', async () => {
    await assert.rejects(
      listAlertasProf({ user: { userId: 'x', role: 'NUTRICIONISTA' } }),
      (err) => err?.status === 403,
    );
  });

  it('PROFESSOR sem perfil → 404', async () => {
    state.prof = null;
    await assert.rejects(
      listAlertasProf({ user: userProf }),
      (err) => err?.status === 404,
    );
  });
});

describe('listAlertasProf — shaping de Alerta', () => {
  it('INACTIVE_7D → severidade high + detalhe com dias', async () => {
    state.rows = [
      {
        tipo: 'INACTIVE_7D', sev: 1,
        aluno_id: 'a-1', aluno_nome: 'João',
        treino_id: null, modalidade: null,
        quando: daysAgo(10),
      },
    ];
    const [alerta] = await listAlertasProf({ user: userProf });
    assert.equal(alerta.tipo, 'INACTIVE_7D');
    assert.equal(alerta.severidade, 'high');
    assert.equal(alerta.alunoId, 'a-1');
    assert.equal(alerta.alunoNome, 'João');
    assert.match(alerta.detalhe, /Sem atividade há 10 dias/);
    assert.equal(alerta.treinoId, undefined);
    assert.equal(alerta.modalidade, undefined);
  });

  it('INACTIVE_7D sem timestamp → "Nunca registrou atividade"', async () => {
    state.rows = [
      {
        tipo: 'INACTIVE_7D', sev: 1,
        aluno_id: 'a-2', aluno_nome: 'Maria',
        treino_id: null, modalidade: null, quando: null,
      },
    ];
    const [alerta] = await listAlertasProf({ user: userProf });
    assert.equal(alerta.detalhe, 'Nunca registrou atividade');
    assert.equal(alerta.desde, null);
  });

  it('MISSED_WORKOUT → severidade high + detalhe com modalidade', async () => {
    state.rows = [
      {
        tipo: 'MISSED_WORKOUT', sev: 1,
        aluno_id: 'a-1', aluno_nome: 'João',
        treino_id: 't-99', modalidade: 'NATACAO',
        quando: daysAgo(3),
      },
    ];
    const [alerta] = await listAlertasProf({ user: userProf });
    assert.equal(alerta.tipo, 'MISSED_WORKOUT');
    assert.equal(alerta.severidade, 'high');
    assert.equal(alerta.treinoId, 't-99');
    assert.match(alerta.detalhe, /Faltou natação \(3d atrás\)/);
  });

  it('STREAK_BROKEN → severidade medium + detalhe fixo (sem timestamp)', async () => {
    state.rows = [
      {
        tipo: 'STREAK_BROKEN', sev: 2,
        aluno_id: 'a-1', aluno_nome: 'João',
        treino_id: null, modalidade: null, quando: null,
      },
    ];
    const [alerta] = await listAlertasProf({ user: userProf });
    assert.equal(alerta.severidade, 'medium');
    assert.match(alerta.detalhe, /Quebrou streak/);
  });

  it('MODALIDADE_GAP → severidade low + label PT da modalidade', async () => {
    state.rows = [
      {
        tipo: 'MODALIDADE_GAP', sev: 3,
        aluno_id: 'a-1', aluno_nome: 'João',
        treino_id: null, modalidade: 'CICLISMO',
        quando: daysAgo(20),
      },
    ];
    const [alerta] = await listAlertasProf({ user: userProf });
    assert.equal(alerta.severidade, 'low');
    assert.match(alerta.detalhe, /Sem ciclismo há 20 dias/);
  });

  it('OUTRO em modalidade vira "treino" no label PT', async () => {
    state.rows = [
      {
        tipo: 'MODALIDADE_GAP', sev: 3,
        aluno_id: 'a-1', aluno_nome: 'João',
        treino_id: null, modalidade: 'OUTRO',
        quando: daysAgo(15),
      },
    ];
    const [alerta] = await listAlertasProf({ user: userProf });
    assert.match(alerta.detalhe, /Sem treino há 15 dias/);
  });

  it('preserva a ordem retornada pelo SQL (severidade asc, quando desc)', async () => {
    state.rows = [
      { tipo: 'INACTIVE_7D', sev: 1, aluno_id: 'a-1', aluno_nome: 'A', treino_id: null, modalidade: null, quando: daysAgo(8) },
      { tipo: 'MISSED_WORKOUT', sev: 1, aluno_id: 'a-2', aluno_nome: 'B', treino_id: 't-1', modalidade: 'MUSCULACAO', quando: daysAgo(2) },
      { tipo: 'STREAK_BROKEN', sev: 2, aluno_id: 'a-3', aluno_nome: 'C', treino_id: null, modalidade: null, quando: null },
      { tipo: 'MODALIDADE_GAP', sev: 3, aluno_id: 'a-4', aluno_nome: 'D', treino_id: null, modalidade: 'CORRIDA', quando: daysAgo(20) },
    ];
    const lista = await listAlertasProf({ user: userProf });
    assert.deepEqual(lista.map((a) => a.tipo), [
      'INACTIVE_7D', 'MISSED_WORKOUT', 'STREAK_BROKEN', 'MODALIDADE_GAP',
    ]);
    assert.deepEqual(lista.map((a) => a.severidade), ['high', 'high', 'medium', 'low']);
  });

  it('lista vazia → array vazio (não null)', async () => {
    state.rows = [];
    const lista = await listAlertasProf({ user: userProf });
    assert.deepEqual(lista, []);
  });
});
