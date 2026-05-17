import { describe, it, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// PR #20 — getVolumeSeries: mock de $queryRaw + ACL.
// O SQL real (date_trunc, jsonb_array_elements, LATERAL JOIN) só roda
// em Postgres; aqui validamos:
//   1. ACL via resolveAlunoAccess (aluno dono, prof vinculado, etc).
//   2. weeks clampado pra [4, 52].
//   3. Preenchimento de semanas vazias com zeros.
//   4. Forma do payload retornado (chaves camelCase).

const state = {
  aluno: { id: 'aluno-1', userId: 'user-aluno-1' },
  rows: [],
};

mock.module('../lib/prisma.js', {
  namedExports: {
    prisma: {
      aluno: {
        findUnique: async () => state.aluno,
      },
      $queryRaw: async () => state.rows,
    },
  },
});

let getVolumeSeries;
before(async () => {
  ({ getVolumeSeries } = await import('../services/desempenho.service.js'));
});

beforeEach(() => {
  state.rows = [];
});

const userAluno = { userId: 'user-aluno-1', role: 'ALUNO' };

// Helpers ──────────────────────────────────────────────────────────

function inicioSemanaUTC(d = new Date()) {
  const date = new Date(d);
  date.setUTCHours(0, 0, 0, 0);
  const dow = date.getUTCDay();
  const diff = (dow + 6) % 7;
  date.setUTCDate(date.getUTCDate() - diff);
  return date;
}

function semanaKey(d) {
  return d.toISOString().slice(0, 10);
}

describe('getVolumeSeries — janela e shaping (PR #20)', () => {
  it('default weeks=12 → série com 12 entradas', async () => {
    const out = await getVolumeSeries({ user: userAluno });
    assert.equal(out.weeks, 12);
    assert.equal(out.series.length, 12);
  });

  it('weeks=4 (mínimo) → 4 entradas', async () => {
    const out = await getVolumeSeries({ user: userAluno, weeks: 4 });
    assert.equal(out.weeks, 4);
    assert.equal(out.series.length, 4);
  });

  it('weeks abaixo do mínimo é clampado pra 4', async () => {
    const out = await getVolumeSeries({ user: userAluno, weeks: 1 });
    assert.equal(out.weeks, 4);
  });

  it('weeks acima do máximo é clampado pra 52', async () => {
    const out = await getVolumeSeries({ user: userAluno, weeks: 200 });
    assert.equal(out.weeks, 52);
    assert.equal(out.series.length, 52);
  });

  it('semanas SEM atividade vêm com zeros (gap fill em JS)', async () => {
    state.rows = []; // SQL retorna lista vazia
    const out = await getVolumeSeries({ user: userAluno, weeks: 6 });
    assert.equal(out.series.length, 6);
    for (const s of out.series) {
      assert.equal(s.corridaKm, 0);
      assert.equal(s.ciclismoKm, 0);
      assert.equal(s.natacaoM, 0);
      assert.equal(s.musculacaoKg, 0);
      assert.match(s.semana, /^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('semana com dados mapeia em camelCase', async () => {
    const semanaAtual = semanaKey(inicioSemanaUTC());
    state.rows = [
      {
        semana: semanaAtual,
        corrida_km: '10.5',     // raw vem como string às vezes
        ciclismo_km: 45.2,
        natacao_m: 2500,
        musculacao_kg: 12000,
      },
    ];
    const out = await getVolumeSeries({ user: userAluno, weeks: 8 });
    const atual = out.series.find((s) => s.semana === semanaAtual);
    assert.ok(atual, 'semana atual presente na série');
    assert.equal(atual.corridaKm, 10.5);
    assert.equal(atual.ciclismoKm, 45.2);
    assert.equal(atual.natacaoM, 2500);
    assert.equal(atual.musculacaoKg, 12000);
  });

  it('série sempre ordenada cronologicamente (asc)', async () => {
    const out = await getVolumeSeries({ user: userAluno, weeks: 6 });
    for (let i = 1; i < out.series.length; i++) {
      assert.ok(out.series[i].semana > out.series[i - 1].semana);
    }
  });

  it('primeira semana = início_semana_corrente - (weeks-1)*7d', async () => {
    const out = await getVolumeSeries({ user: userAluno, weeks: 4 });
    const corrente = inicioSemanaUTC();
    const esperado = new Date(corrente);
    esperado.setUTCDate(esperado.getUTCDate() - 21); // (4-1)*7
    assert.equal(out.series[0].semana, semanaKey(esperado));
    // Última = semana corrente
    assert.equal(out.series[out.series.length - 1].semana, semanaKey(corrente));
  });

  it('semanas extras retornadas pelo SQL fora da janela → ignoradas', async () => {
    // SQL devolve uma semana de 2 anos atrás (impossível na prática
    // por causa do filtro WHERE, mas testamos a robustez do shaping).
    state.rows = [
      { semana: '2024-01-01', corrida_km: 999, ciclismo_km: 0, natacao_m: 0, musculacao_kg: 0 },
    ];
    const out = await getVolumeSeries({ user: userAluno, weeks: 4 });
    // Nenhuma série carrega 999 (semana fora da janela é ignorada).
    assert.ok(out.series.every((s) => s.corridaKm !== 999));
  });
});
