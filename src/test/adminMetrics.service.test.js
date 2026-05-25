import { describe, it, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// PR #42 — adminMetrics.service: agrega 9 queries Prisma em paralelo,
// retorna payload congelado pelo contrato (briefing técnico).
//
// Cobre:
//  - semanaCorrenteBrt: cálculo da janela SEG→SEG em BRT (helper pure).
//  - obterMetricasGlobais: forma do payload, normalização porRole,
//    null em taxaAdesao quando prescritos=0, queries esperadas.

const state = {
  // Mocks por método: cada um é uma fn que recebe args do Prisma e
  // devolve o que precisa pro service consolidar.
  userCount: null,
  userGroupBy: null,
  professorCount: null,
  nutricionistaCount: null,
  treinoCount: null, // array — uma chamada de cada vez consome o próximo
  alunoCount: null,  // idem
  treinoCallIdx: 0,
  alunoCallIdx: 0,
};

function resetState() {
  state.userCount = null;
  state.userGroupBy = null;
  state.professorCount = null;
  state.nutricionistaCount = null;
  state.treinoCount = null;
  state.alunoCount = null;
  state.treinoCallIdx = 0;
  state.alunoCallIdx = 0;
}

mock.module('../lib/prisma.js', {
  namedExports: {
    prisma: {
      user: {
        count: async (...args) => state.userCount(...args),
        groupBy: async (...args) => state.userGroupBy(...args),
      },
      professor: {
        count: async (...args) => state.professorCount(...args),
      },
      nutricionista: {
        count: async (...args) => state.nutricionistaCount(...args),
      },
      treino: {
        // 3 chamadas sequenciais: prescritosSemana, concluidosSemana, totalHistorico.
        count: async (...args) => {
          const v = state.treinoCount[state.treinoCallIdx];
          state.treinoCallIdx += 1;
          return typeof v === 'function' ? v(...args) : v;
        },
      },
      aluno: {
        // 3 chamadas: alunosSemAtividade7d, alunosSemProfessor, alunosSemAlvo.
        count: async (...args) => {
          const v = state.alunoCount[state.alunoCallIdx];
          state.alunoCallIdx += 1;
          return typeof v === 'function' ? v(...args) : v;
        },
      },
    },
  },
});

let mod;
before(async () => {
  mod = await import('../services/adminMetrics.service.js');
});

beforeEach(() => resetState());

// ──────────────────────────────────────────────────────────────────────
// semanaCorrenteBrt (pure)
// ──────────────────────────────────────────────────────────────────────

describe('semanaCorrenteBrt', () => {
  it('quarta-feira BRT → segunda da mesma semana até segunda seguinte', () => {
    // 2026-05-27 14:00 BRT = 2026-05-27 17:00 UTC (quarta)
    const now = new Date('2026-05-27T17:00:00.000Z');
    const { inicio, fim } = mod.semanaCorrenteBrt(now);
    // SEG 2026-05-25 00:00 BRT = 2026-05-25 03:00 UTC
    assert.equal(inicio.toISOString(), '2026-05-25T03:00:00.000Z');
    // SEG 2026-06-01 00:00 BRT = 2026-06-01 03:00 UTC
    assert.equal(fim.toISOString(), '2026-06-01T03:00:00.000Z');
  });

  it('domingo noite BRT → ainda conta como semana que termina segunda 00:00', () => {
    // 2026-05-31 22:00 BRT = 2026-06-01 01:00 UTC (domingo BRT)
    const now = new Date('2026-06-01T01:00:00.000Z');
    const { inicio, fim } = mod.semanaCorrenteBrt(now);
    assert.equal(inicio.toISOString(), '2026-05-25T03:00:00.000Z');
    assert.equal(fim.toISOString(), '2026-06-01T03:00:00.000Z');
  });

  it('segunda 00:30 BRT → já é semana nova', () => {
    // 2026-06-01 00:30 BRT = 2026-06-01 03:30 UTC
    const now = new Date('2026-06-01T03:30:00.000Z');
    const { inicio, fim } = mod.semanaCorrenteBrt(now);
    assert.equal(inicio.toISOString(), '2026-06-01T03:00:00.000Z');
    assert.equal(fim.toISOString(), '2026-06-08T03:00:00.000Z');
  });

  it('janela tem exatamente 7 dias', () => {
    const { inicio, fim } = mod.semanaCorrenteBrt(new Date('2026-05-27T17:00:00.000Z'));
    const dias = (fim.getTime() - inicio.getTime()) / (24 * 60 * 60 * 1000);
    assert.equal(dias, 7);
  });
});

// ──────────────────────────────────────────────────────────────────────
// obterMetricasGlobais
// ──────────────────────────────────────────────────────────────────────

function setupHappyPath() {
  state.userCount = async ({ where } = {}) => {
    if (where?.ativo === true) return 46;
    return 47;
  };
  state.userGroupBy = async () => [
    { role: 'ALUNO', _count: { _all: 38 } },
    { role: 'PROFESSOR', _count: { _all: 5 } },
    { role: 'NUTRICIONISTA', _count: { _all: 2 } },
    { role: 'ADMIN', _count: { _all: 1 } },
  ];
  state.professorCount = async () => 2;
  state.nutricionistaCount = async () => 1;
  state.treinoCount = [124, 89, 3842];
  state.alunoCount = [6, 2, 11];
}

describe('obterMetricasGlobais', () => {
  it('happy path: monta payload completo conforme contrato', async () => {
    setupHappyPath();
    const now = new Date('2026-05-27T17:00:00.000Z');
    const out = await mod.obterMetricasGlobais(now);

    assert.equal(out.geradoEm, now.toISOString());
    assert.deepEqual(out.usuarios, {
      total: 47,
      ativos: 46,
      porRole: { ALUNO: 38, PROFESSOR: 5, NUTRICIONISTA: 2, ADMIN: 1 },
      pendentes: { professores: 2, nutris: 1 },
    });
    assert.deepEqual(out.treinos, {
      prescritosSemana: 124,
      concluidosSemana: 89,
      taxaAdesao: 0.72, // 89/124 = 0.7177 → arredondado pra 2 casas = 0.72
      totalHistorico: 3842,
    });
    assert.deepEqual(out.alertas, {
      alunosSemAtividade7d: 6,
      alunosSemProfessor: 2,
      alunosSemAlvo: 11,
    });
  });

  it('porRole normaliza chaves ausentes pra 0', async () => {
    setupHappyPath();
    state.userGroupBy = async () => [
      { role: 'ALUNO', _count: { _all: 10 } },
      // PROFESSOR/NUTRI/ADMIN ausentes — service tem que preencher com 0
    ];
    const out = await mod.obterMetricasGlobais(new Date('2026-05-27T17:00:00.000Z'));
    assert.deepEqual(out.usuarios.porRole, {
      ALUNO: 10, PROFESSOR: 0, NUTRICIONISTA: 0, ADMIN: 0,
    });
  });

  it('taxaAdesao=null quando prescritosSemana=0 (evita NaN no front)', async () => {
    setupHappyPath();
    state.treinoCount = [0, 0, 100]; // 0 prescritos, 0 concluidos, 100 histórico
    const out = await mod.obterMetricasGlobais(new Date('2026-05-27T17:00:00.000Z'));
    assert.equal(out.treinos.prescritosSemana, 0);
    assert.equal(out.treinos.concluidosSemana, 0);
    assert.equal(out.treinos.taxaAdesao, null);
  });

  it('taxaAdesao arredonda pra 2 casas decimais', async () => {
    setupHappyPath();
    state.treinoCount = [3, 1, 100]; // 1/3 = 0.333...
    const out = await mod.obterMetricasGlobais(new Date('2026-05-27T17:00:00.000Z'));
    assert.equal(out.treinos.taxaAdesao, 0.33);
  });

  it('pendentes filtra por user.ativo=false', async () => {
    setupHappyPath();
    let capturedProfWhere = null;
    let capturedNutriWhere = null;
    state.professorCount = async ({ where } = {}) => { capturedProfWhere = where; return 0; };
    state.nutricionistaCount = async ({ where } = {}) => { capturedNutriWhere = where; return 0; };
    await mod.obterMetricasGlobais(new Date('2026-05-27T17:00:00.000Z'));
    assert.deepEqual(capturedProfWhere, { user: { ativo: false } });
    assert.deepEqual(capturedNutriWhere, { user: { ativo: false } });
  });

  it('alertas filtram por user.ativo=true (não contam aluno desativado)', async () => {
    setupHappyPath();
    const capturedAlunoWheres = [];
    state.alunoCount = [
      async ({ where } = {}) => { capturedAlunoWheres.push(where); return 0; },
      async ({ where } = {}) => { capturedAlunoWheres.push(where); return 0; },
      async ({ where } = {}) => { capturedAlunoWheres.push(where); return 0; },
    ];
    await mod.obterMetricasGlobais(new Date('2026-05-27T17:00:00.000Z'));
    // Todos os 3 alertas precisam ter user:{ativo:true} no filtro
    for (const w of capturedAlunoWheres) {
      assert.deepEqual(w.user, { ativo: true }, `alerta sem filtro user.ativo: ${JSON.stringify(w)}`);
    }
  });

  it('alunosSemAlvo filtra Prova prioridade=A e arquivada=false', async () => {
    setupHappyPath();
    const capturedWheres = [];
    state.alunoCount = [
      async ({ where } = {}) => { capturedWheres.push(where); return 0; },
      async ({ where } = {}) => { capturedWheres.push(where); return 0; },
      async ({ where } = {}) => { capturedWheres.push(where); return 0; },
    ];
    await mod.obterMetricasGlobais(new Date('2026-05-27T17:00:00.000Z'));
    // 3ª chamada é alunosSemAlvo
    assert.deepEqual(capturedWheres[2].provas, {
      none: { prioridade: 'A', arquivada: false },
    });
  });
});
