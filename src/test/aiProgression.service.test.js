import { describe, it, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.VOICE_ENABLED = 'true';
process.env.ANTHROPIC_API_KEY = 'test-key-not-real';

// ─── Estado mockável do prisma ──────────────────────────────────────

const state = {
  professor: null,
  vinculo: null,
  aluno: null,
  raw: [],
};

mock.module('../lib/prisma.js', {
  namedExports: {
    prisma: {
      professor: {
        findUnique: async ({ where }) =>
          state.professor && where.userId === state.professor.userId ? state.professor : null,
      },
      vinculoProfessor: {
        findUnique: async ({ where }) => {
          if (!state.vinculo) return null;
          const k = where.alunoId_professorId;
          if (k.alunoId === state.vinculo.alunoId && k.professorId === state.vinculo.professorId) {
            return state.vinculo;
          }
          return null;
        },
      },
      aluno: {
        findUnique: async ({ where }) =>
          state.aluno && where.id === state.aluno.id ? state.aluno : null,
      },
      $queryRaw: async () => state.raw,
    },
  },
});

let svc;
let dataSvc;

before(async () => {
  svc = await import('../services/aiProgression.service.js');
  dataSvc = await import('../services/aiProgressionData.service.js');
});

beforeEach(() => {
  state.professor = { id: 'prof-1', userId: 'user-prof-1' };
  state.vinculo = { id: 'v-1', alunoId: 'aluno-1', professorId: 'prof-1' };
  state.aluno = { id: 'aluno-1', user: { nome: 'Carlos Eduardo Mendes' } };
  state.raw = [];
});

function llmReturning(input) {
  return {
    messages: {
      create: async () => ({
        content: [{ type: 'tool_use', name: 'suggest_progression', input }],
      }),
    },
  };
}

function makeTreinoRow({ data, sets }) {
  return {
    id: `t-${data}`,
    dataAlvo: new Date(data),
    detalhes: {
      tipo: 'musculacao',
      exercicios: [{ nome: 'Supino', realizado: sets }],
    },
  };
}

// ─── Tests: aiProgressionData.service ────────────────────────────────

describe('buildExercicioSnapshot — set-resolution', () => {
  it('histórico vazio → snapshot empty (não quebra)', async () => {
    state.raw = [];
    const snap = await dataSvc.buildExercicioSnapshot({
      alunoId: 'aluno-1', exercicioNome: 'Supino',
    });
    assert.equal(snap.execucoes.length, 0);
    assert.equal(snap.rpeMedioRecente, null);
    assert.equal(snap.houveFalhaDeReps, false);
    assert.equal(snap.diasDesdeUltima, null);
  });

  it('agrega sets com kg/reps/rpe; calcula RPE médio recente', async () => {
    state.raw = [
      makeTreinoRow({
        data: '2026-05-12',
        sets: [
          { kg: 80, reps: 8, rpe: 7 },
          { kg: 80, reps: 8, rpe: 8 },
          { kg: 80, reps: 7, rpe: 9 },
        ],
      }),
    ];
    const snap = await dataSvc.buildExercicioSnapshot({
      alunoId: 'aluno-1', exercicioNome: 'Supino',
    });
    assert.equal(snap.execucoes.length, 1);
    assert.equal(snap.execucoes[0].sets.length, 3);
    assert.equal(snap.rpeMedioRecente, 8); // (7+8+9)/3 = 8
  });

  it('detecta falha de reps quando drop > 25% entre sets', async () => {
    state.raw = [
      makeTreinoRow({
        data: '2026-05-12',
        sets: [
          { kg: 80, reps: 10, rpe: 7 },
          { kg: 80, reps: 6, rpe: 9 },
        ],
      }),
    ];
    const snap = await dataSvc.buildExercicioSnapshot({
      alunoId: 'aluno-1', exercicioNome: 'Supino',
    });
    // drop = (10-6)/10 = 40% > 25%
    assert.equal(snap.houveFalhaDeReps, true);
  });

  it('drop ≤ 25% NÃO marca falha', async () => {
    state.raw = [
      makeTreinoRow({
        data: '2026-05-12',
        sets: [
          { kg: 80, reps: 8, rpe: 7 },
          { kg: 80, reps: 7, rpe: 8 },
        ],
      }),
    ];
    const snap = await dataSvc.buildExercicioSnapshot({
      alunoId: 'aluno-1', exercicioNome: 'Supino',
    });
    // drop = (8-7)/8 = 12.5% ≤ 25%
    assert.equal(snap.houveFalhaDeReps, false);
  });

  it('descarta sets vazios (sem kg E sem reps)', async () => {
    state.raw = [
      makeTreinoRow({
        data: '2026-05-12',
        sets: [
          { kg: 80, reps: 8, rpe: 7 },
          { rpe: null },                      // vazio
          { kg: null, reps: null, rpe: null }, // vazio
        ],
      }),
    ];
    const snap = await dataSvc.buildExercicioSnapshot({
      alunoId: 'aluno-1', exercicioNome: 'Supino',
    });
    assert.equal(snap.execucoes[0].sets.length, 1);
  });

  it('execução só com prescrição (sem realizado real) é ignorada', async () => {
    state.raw = [
      makeTreinoRow({
        data: '2026-05-12',
        sets: [], // realizado vazio
      }),
    ];
    const snap = await dataSvc.buildExercicioSnapshot({
      alunoId: 'aluno-1', exercicioNome: 'Supino',
    });
    assert.equal(snap.execucoes.length, 0);
  });
});

// ─── Tests: checkProfessorOwnership ─────────────────────────────────

describe('checkProfessorOwnership', () => {
  it('vínculo existe → true', async () => {
    const ok = await dataSvc.checkProfessorOwnership({
      userId: 'user-prof-1', alunoId: 'aluno-1',
    });
    assert.equal(ok, true);
  });

  it('professor sem perfil → false', async () => {
    state.professor = null;
    const ok = await dataSvc.checkProfessorOwnership({
      userId: 'user-prof-fantasma', alunoId: 'aluno-1',
    });
    assert.equal(ok, false);
  });

  it('aluno não vinculado → false', async () => {
    state.vinculo = null;
    const ok = await dataSvc.checkProfessorOwnership({
      userId: 'user-prof-1', alunoId: 'aluno-outro',
    });
    assert.equal(ok, false);
  });
});

// ─── Tests: suggestProgression (LLM mockado) ────────────────────────

describe('suggestProgression — ACL e gates pré-LLM', () => {
  beforeEach(() => svc.__resetClientForTests());

  it('ALUNO chamando → 403 SEM tocar LLM', async () => {
    let llmCalled = false;
    svc.__setClientForTests({
      messages: { create: async () => { llmCalled = true; return { content: [] }; } },
    });
    await assert.rejects(
      svc.suggestProgression({
        user: { userId: 'u', role: 'ALUNO' },
        alunoId: 'aluno-1', exercicioNome: 'Supino', modalidade: 'MUSCULACAO',
      }),
      (e) => e.status === 403,
    );
    assert.equal(llmCalled, false);
  });

  it('PROFESSOR sem vínculo com aluno → 403 SEM tocar LLM (anti billing-drain)', async () => {
    state.vinculo = null;
    let llmCalled = false;
    svc.__setClientForTests({
      messages: { create: async () => { llmCalled = true; return { content: [] }; } },
    });
    await assert.rejects(
      svc.suggestProgression({
        user: { userId: 'user-prof-1', role: 'PROFESSOR' },
        alunoId: 'aluno-outro', exercicioNome: 'Supino', modalidade: 'MUSCULACAO',
      }),
      (e) => e.status === 403,
    );
    assert.equal(llmCalled, false);
  });
});

describe('suggestProgression — fluxos LLM (musculação)', () => {
  beforeEach(() => svc.__resetClientForTests());

  it('happy path — passa shape válido direto', async () => {
    state.raw = [makeTreinoRow({
      data: '2026-05-12',
      sets: [
        { kg: 80, reps: 8, rpe: 7 },
        { kg: 80, reps: 8, rpe: 7 },
      ],
    })];
    svc.__setClientForTests(llmReturning({
      sets: 3, reps: '8-10', cargaEstimadaKg: 82.5, rpeAlvo: 7,
      justificativa: 'RPE médio 7 estável, sobe 2.5kg pra próximo estímulo.',
      tipoProgressao: 'intensidade',
    }));

    const out = await svc.suggestProgression({
      user: { userId: 'user-prof-1', role: 'PROFESSOR' },
      alunoId: 'aluno-1', exercicioNome: 'Supino', modalidade: 'MUSCULACAO',
    });
    assert.equal(out.sugestao.sets, 3);
    assert.equal(out.sugestao.cargaEstimadaKg, 82.5);
    assert.equal(out.sugestao.tipoProgressao, 'intensidade');
    assert.equal(out.contextoUsado.execucoesConsideradas, 1);
    assert.equal(out.contextoUsado.modalidade, 'MUSCULACAO');
  });

  it('sem histórico — LLM devolve conservador, service aceita', async () => {
    state.raw = [];
    svc.__setClientForTests(llmReturning({
      sets: 3, reps: '8-10', cargaEstimadaKg: null, rpeAlvo: null,
      justificativa: 'Sem histórico — começamos leve para calibrar.',
      tipoProgressao: 'manutencao',
    }));
    const out = await svc.suggestProgression({
      user: { userId: 'user-prof-1', role: 'PROFESSOR' },
      alunoId: 'aluno-1', exercicioNome: 'Supino', modalidade: 'MUSCULACAO',
    });
    assert.equal(out.sugestao.cargaEstimadaKg, null);
    assert.equal(out.contextoUsado.execucoesConsideradas, 0);
  });

  it('Zod fail → repair tolerante salva o dia', async () => {
    state.raw = [makeTreinoRow({
      data: '2026-05-12',
      sets: [{ kg: 80, reps: 8, rpe: 7 }],
    })];
    svc.__setClientForTests(llmReturning({
      sets: 50,                            // fora do range
      reps: '',                            // vazio
      cargaEstimadaKg: -10,                // negativo
      rpeAlvo: 15,                         // fora do range
      justificativa: 'curt',               // < 10 chars
      tipoProgressao: 'rolar',             // não existe
    }));
    const out = await svc.suggestProgression({
      user: { userId: 'user-prof-1', role: 'PROFESSOR' },
      alunoId: 'aluno-1', exercicioNome: 'Supino', modalidade: 'MUSCULACAO',
    });
    assert.ok(out.sugestao.sets >= 1 && out.sugestao.sets <= 10);
    assert.ok(out.sugestao.reps.length > 0);
    assert.equal(out.sugestao.cargaEstimadaKg, null);
    assert.equal(out.sugestao.rpeAlvo, null);
    assert.ok(out.sugestao.justificativa.length >= 10);
    assert.equal(out.sugestao.tipoProgressao, 'manutencao');
  });

  it('LLM retorna tool_use ausente → 502', async () => {
    state.raw = [];
    svc.__setClientForTests({
      messages: { create: async () => ({ content: [{ type: 'text', text: 'sem tool' }] }) },
    });
    await assert.rejects(
      svc.suggestProgression({
        user: { userId: 'user-prof-1', role: 'PROFESSOR' },
        alunoId: 'aluno-1', exercicioNome: 'Supino', modalidade: 'MUSCULACAO',
      }),
      (e) => e.status === 502,
    );
  });

  it('LLM timeout → 504', async () => {
    state.raw = [];
    svc.__setClientForTests({
      messages: { create: async () => { throw new Error('ETIMEDOUT'); } },
    });
    await assert.rejects(
      svc.suggestProgression({
        user: { userId: 'user-prof-1', role: 'PROFESSOR' },
        alunoId: 'aluno-1', exercicioNome: 'Supino', modalidade: 'MUSCULACAO',
      }),
      (e) => e.status === 504,
    );
  });

  it('LLM rate-limit upstream (429) → propaga 429', async () => {
    state.raw = [];
    const err = new Error('rate limited');
    err.status = 429;
    svc.__setClientForTests({
      messages: { create: async () => { throw err; } },
    });
    await assert.rejects(
      svc.suggestProgression({
        user: { userId: 'user-prof-1', role: 'PROFESSOR' },
        alunoId: 'aluno-1', exercicioNome: 'Supino', modalidade: 'MUSCULACAO',
      }),
      (e) => e.status === 429,
    );
  });
});

describe('suggestProgression — calistenia (sem kg)', () => {
  beforeEach(() => svc.__resetClientForTests());

  it('calistenia: força cargaEstimadaKg=null mesmo se LLM teimar em mandar valor', async () => {
    state.raw = [];
    svc.__setClientForTests(llmReturning({
      sets: 3, reps: '10-12',
      cargaEstimadaKg: 42,                 // LLM rebelde
      rpeAlvo: 7,
      justificativa: 'Sem histórico — faixa inicial.',
      tipoProgressao: 'manutencao',
    }));
    const out = await svc.suggestProgression({
      user: { userId: 'user-prof-1', role: 'PROFESSOR' },
      alunoId: 'aluno-1', exercicioNome: 'Barra fixa', modalidade: 'CALISTENIA',
    });
    assert.equal(out.sugestao.cargaEstimadaKg, null, 'calistenia força null em kg');
    assert.equal(out.sugestao.reps, '10-12');
  });

  it('calistenia + Zod repair: cargaEstimadaKg inválido → null + reps default calistenia', async () => {
    state.raw = [];
    svc.__setClientForTests(llmReturning({
      sets: 99, reps: 0, cargaEstimadaKg: 'x',
      rpeAlvo: null, justificativa: '', tipoProgressao: null,
    }));
    const out = await svc.suggestProgression({
      user: { userId: 'user-prof-1', role: 'PROFESSOR' },
      alunoId: 'aluno-1', exercicioNome: 'Flexão', modalidade: 'CALISTENIA',
    });
    assert.equal(out.sugestao.cargaEstimadaKg, null);
    assert.ok(out.sugestao.reps.length > 0);
  });
});
