import { describe, it, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.VOICE_ENABLED = 'true';
process.env.ANTHROPIC_API_KEY = 'test-key-not-real';

// PR #30 — testes do AI Draft service. Mock prisma + Anthropic + lib
// de fuzzy match.

const state = {
  professor: null,
  vinculo: null,
  aluno: null,
  recordes: [],
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
        findUnique: async ({ where }) => {
          if (!state.aluno || where.id !== state.aluno.id) return null;
          return {
            user: { nome: state.aluno.nome },
            recordes: state.recordes,
          };
        },
      },
    },
  },
});

// Mock da lib de fuzzy match — testa contrato sem precisar de pg_trgm real.
const matchCalls = [];
let matchResultBuilder = null;
mock.module('../lib/exercicioMatch.js', {
  namedExports: {
    matchExerciciosBatch: async (nomes) => {
      matchCalls.push(nomes);
      if (matchResultBuilder) return matchResultBuilder(nomes);
      // Default: tudo verde com IDs sintéticos.
      return nomes.map((n, i) => ({
        nomeLlm: n,
        exercicioId: `ex-${i}`,
        nomeCanonico: n,
        similarityScore: 0.95,
        confianca: 'verde',
      }));
    },
  },
});

let svc;

before(async () => {
  svc = await import('../services/aiDraftTreino.service.js');
});

beforeEach(() => {
  state.professor = { id: 'prof-1', userId: 'user-prof-1' };
  state.vinculo = { id: 'v-1', alunoId: 'aluno-1', professorId: 'prof-1' };
  state.aluno = { id: 'aluno-1', nome: 'Carlos Eduardo Mendes' };
  state.recordes = [];
  matchCalls.length = 0;
  matchResultBuilder = null;
  svc.__resetClientForTests();
});

function llmReturning(input) {
  return {
    messages: {
      create: async () => ({
        content: [{ type: 'tool_use', name: 'draft_treino', input }],
      }),
    },
  };
}

function validDraft() {
  return {
    titulo: 'ABCD Hipertrofia Intermediário',
    objetivoResumo: 'Ciclo de hipertrofia em 4 dias focado em ombros e peito.',
    diasSugeridos: [
      {
        label: 'Dia A — Peito/Tríceps',
        foco: 'Peito',
        exercicios: [
          { nome: 'Supino Reto', series: 4, repsRange: '8-12', cargaPctRP: null, descansoSeg: 90 },
          { nome: 'Crucifixo Inclinado', series: 3, repsRange: '10-12', cargaPctRP: null, descansoSeg: 60 },
        ],
      },
      {
        label: 'Dia B — Costas/Bíceps',
        foco: 'Costas',
        exercicios: [
          { nome: 'Barra Fixa', series: 4, repsRange: '6-10', cargaPctRP: null, descansoSeg: 90 },
        ],
      },
    ],
  };
}

// ─── ACL e gates pré-LLM ────────────────────────────────────────────

describe('generateDraftTreino — ACL e gates pré-LLM', () => {
  it('ALUNO chamando → 403 SEM tocar LLM', async () => {
    let llmCalled = false;
    svc.__setClientForTests({
      messages: { create: async () => { llmCalled = true; return { content: [] }; } },
    });
    await assert.rejects(
      svc.generateDraftTreino({
        user: { userId: 'u', role: 'ALUNO' },
        prompt: 'ABCD hipertrofia',
      }),
      (e) => e.status === 403,
    );
    assert.equal(llmCalled, false);
  });

  it('PROFESSOR com alunoId não-vinculado → 403 SEM tocar LLM', async () => {
    state.vinculo = null;
    let llmCalled = false;
    svc.__setClientForTests({
      messages: { create: async () => { llmCalled = true; return { content: [] }; } },
    });
    await assert.rejects(
      svc.generateDraftTreino({
        user: { userId: 'user-prof-1', role: 'PROFESSOR' },
        prompt: 'ABCD',
        alunoId: 'aluno-outro',
      }),
      (e) => e.status === 403,
    );
    assert.equal(llmCalled, false);
  });

  it('PROFESSOR SEM alunoId → permite (rotina genérica)', async () => {
    svc.__setClientForTests(llmReturning(validDraft()));
    const out = await svc.generateDraftTreino({
      user: { userId: 'user-prof-1', role: 'PROFESSOR' },
      prompt: 'ABCD hipertrofia intermediário',
    });
    assert.equal(out.titulo, 'ABCD Hipertrofia Intermediário');
  });
});

// ─── Happy path + hidratação de fuzzy match ─────────────────────────

describe('generateDraftTreino — pipeline completo', () => {
  it('happy path: passa Zod, chama fuzzy match, hidrata + computa meta', async () => {
    svc.__setClientForTests(llmReturning(validDraft()));

    const out = await svc.generateDraftTreino({
      user: { userId: 'user-prof-1', role: 'PROFESSOR' },
      prompt: 'ABCD hipertrofia',
      alunoId: 'aluno-1',
    });

    assert.equal(out.diasSugeridos.length, 2);
    assert.equal(out.diasSugeridos[0].exercicios.length, 2);
    // Hidratação: cada exercício ganha confianca, exercicioId, etc
    for (const dia of out.diasSugeridos) {
      for (const ex of dia.exercicios) {
        assert.ok(['verde', 'laranja', 'vermelho'].includes(ex.confianca));
        assert.ok('exercicioId' in ex);
        assert.ok('similarityScore' in ex);
      }
    }
    // Meta agregada
    assert.equal(out.meta.matchesVerde, 3, 'mock default = tudo verde');
    assert.equal(out.meta.matchesLaranja, 0);
    assert.equal(out.meta.matchesVermelho, 0);
    assert.equal(out.meta.exerciciosUnicos, 3);
  });

  it('meta agregada conta verdes + laranjas + vermelhos corretamente', async () => {
    svc.__setClientForTests(llmReturning(validDraft()));

    matchResultBuilder = (nomes) => nomes.map((n, i) => ({
      nomeLlm: n,
      exercicioId: i < 2 ? `ex-${i}` : null,
      nomeCanonico: i < 2 ? n : null,
      similarityScore: i === 0 ? 0.95 : i === 1 ? 0.7 : 0.3,
      confianca: i === 0 ? 'verde' : i === 1 ? 'laranja' : 'vermelho',
    }));

    const out = await svc.generateDraftTreino({
      user: { userId: 'user-prof-1', role: 'PROFESSOR' },
      prompt: 'rotina',
    });
    assert.equal(out.meta.matchesVerde, 1);
    assert.equal(out.meta.matchesLaranja, 1);
    assert.equal(out.meta.matchesVermelho, 1);
  });

  it('fuzzy match recebe TODOS os nomes na ordem de aparição (preserva duplicados)', async () => {
    const draftComDup = validDraft();
    draftComDup.diasSugeridos[1].exercicios.push(
      { nome: 'Supino Reto', series: 3, repsRange: '6-10', cargaPctRP: null, descansoSeg: 90 }, // duplicate
    );
    svc.__setClientForTests(llmReturning(draftComDup));

    await svc.generateDraftTreino({
      user: { userId: 'user-prof-1', role: 'PROFESSOR' },
      prompt: 'rotina',
    });

    assert.equal(matchCalls.length, 1);
    assert.deepEqual(matchCalls[0], [
      'Supino Reto', 'Crucifixo Inclinado', 'Barra Fixa', 'Supino Reto',
    ]);
  });
});

// ─── Contexto opcional do aluno ─────────────────────────────────────

describe('generateDraftTreino — contexto do aluno (alunoId)', () => {
  it('com alunoId → carrega RPs recentes e passa pro LLM', async () => {
    state.recordes = [
      { exercicio: 'Supino', valor: 100, unidade: 'kg', reps: 5 },
      { exercicio: 'Agachamento', valor: 140, unidade: 'kg', reps: 5 },
    ];
    let receivedPayload = null;
    svc.__setClientForTests({
      messages: {
        create: async (req) => {
          receivedPayload = req.messages[0].content[0].text;
          return { content: [{ type: 'tool_use', name: 'draft_treino', input: validDraft() }] };
        },
      },
    });

    await svc.generateDraftTreino({
      user: { userId: 'user-prof-1', role: 'PROFESSOR' },
      prompt: 'ABCD',
      alunoId: 'aluno-1',
    });

    assert.ok(receivedPayload.includes('contextoAluno'), 'prompt deve carregar contextoAluno');
    assert.ok(receivedPayload.includes('Carlos M.'), 'nome encurtado (privacidade)');
    assert.ok(receivedPayload.includes('Supino'), 'RPs presentes no payload');
  });

  it('sem alunoId → payload é só descrição (não cita contextoAluno)', async () => {
    let receivedPayload = null;
    svc.__setClientForTests({
      messages: {
        create: async (req) => {
          receivedPayload = req.messages[0].content[0].text;
          return { content: [{ type: 'tool_use', name: 'draft_treino', input: validDraft() }] };
        },
      },
    });

    await svc.generateDraftTreino({
      user: { userId: 'user-prof-1', role: 'PROFESSOR' },
      prompt: 'rotina genérica',
    });

    assert.equal(receivedPayload.includes('contextoAluno'), false);
  });
});

// ─── Zod repair ─────────────────────────────────────────────────────

describe('generateDraftTreino — Zod repair tolerante', () => {
  it('LLM cospe sets=999, descanso=10s, cargaPctRP=200 → repair clampa', async () => {
    svc.__setClientForTests(llmReturning({
      titulo: 'AB',                                         // < min 3
      objetivoResumo: '',                                    // vazio
      diasSugeridos: [
        {
          label: '',
          foco: '',
          exercicios: [
            { nome: 'Supino', series: 999, repsRange: '', cargaPctRP: 200, descansoSeg: 10 },
            { nome: 'A', series: 0, repsRange: 'X', cargaPctRP: 'x', descansoSeg: 9999 }, // nome curto demais
          ],
        },
      ],
    }));

    const out = await svc.generateDraftTreino({
      user: { userId: 'user-prof-1', role: 'PROFESSOR' },
      prompt: 'rotina',
    });
    // titulo defaultado
    assert.ok(out.titulo.length >= 3);
    assert.ok(out.objetivoResumo.length >= 1);
    // exercícios sobreviventes têm valores dentro do range
    for (const dia of out.diasSugeridos) {
      for (const ex of dia.exercicios) {
        assert.ok(ex.series >= 1 && ex.series <= 8);
        assert.ok(ex.descansoSeg >= 30 && ex.descansoSeg <= 300);
        if (ex.cargaPctRP !== null) {
          assert.ok(ex.cargaPctRP >= 30 && ex.cargaPctRP <= 120);
        }
      }
    }
  });

  it('LLM gera diasSugeridos vazio APÓS repair → 502 (sem como salvar)', async () => {
    svc.__setClientForTests(llmReturning({
      titulo: 'X',
      objetivoResumo: '',
      diasSugeridos: [{ label: '', foco: '', exercicios: [{ nome: '' }] }], // dia sem exercício válido
    }));
    await assert.rejects(
      svc.generateDraftTreino({
        user: { userId: 'user-prof-1', role: 'PROFESSOR' },
        prompt: 'rotina',
      }),
      (e) => e.status === 502,
    );
  });
});

// ─── Falhas de upstream ─────────────────────────────────────────────

describe('generateDraftTreino — falhas LLM', () => {
  it('tool_use ausente → 502', async () => {
    svc.__setClientForTests({
      messages: { create: async () => ({ content: [{ type: 'text', text: 'falei demais' }] }) },
    });
    await assert.rejects(
      svc.generateDraftTreino({
        user: { userId: 'user-prof-1', role: 'PROFESSOR' },
        prompt: 'rotina',
      }),
      (e) => e.status === 502,
    );
  });

  it('timeout → 504', async () => {
    svc.__setClientForTests({
      messages: { create: async () => { throw new Error('ETIMEDOUT'); } },
    });
    await assert.rejects(
      svc.generateDraftTreino({
        user: { userId: 'user-prof-1', role: 'PROFESSOR' },
        prompt: 'rotina',
      }),
      (e) => e.status === 504,
    );
  });

  it('upstream 429 → propaga 429 (cliente mostra "tente em alguns minutos")', async () => {
    const err = new Error('rate limited');
    err.status = 429;
    svc.__setClientForTests({
      messages: { create: async () => { throw err; } },
    });
    await assert.rejects(
      svc.generateDraftTreino({
        user: { userId: 'user-prof-1', role: 'PROFESSOR' },
        prompt: 'rotina',
      }),
      (e) => e.status === 429,
    );
  });
});
