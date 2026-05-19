import { describe, it, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.VOICE_ENABLED = 'true';
process.env.ANTHROPIC_API_KEY = 'test-key-not-real';

// PR #32 — testes do alunoInsight.service.
//
// Cobre transições críticas:
//   - cache hit não toca LLM
//   - sem dados → atalho estático
//   - happy path → narra
//   - veto bate na 1ª, passa na 2ª
//   - veto bate 2x → fallback estático
//   - LLM down + cache existe → stale
//   - LLM down sem cache → fallback estático (não 5xx)

const state = {
  aluno: null,
  cache: null,
  upsertCalls: [],
  snapshot: null,
};

mock.module('../lib/prisma.js', {
  namedExports: {
    prisma: {
      aluno: {
        findUnique: async ({ where }) =>
          state.aluno && (where.userId === state.aluno.userId || where.id === state.aluno.id)
            ? state.aluno : null,
      },
      professor: { findUnique: async () => null },
      nutricionista: { findUnique: async () => null },
      vinculoProfessor: { findUnique: async () => null },
      vinculoNutricionista: { findUnique: async () => null },
      alunoInsightSemanal: {
        findUnique: async ({ where }) =>
          state.cache && state.cache.alunoId === where.alunoId ? state.cache : null,
        upsert: async ({ where, create, update }) => {
          state.upsertCalls.push({ where, create, update });
          state.cache = {
            id: 'ins-1',
            alunoId: where.alunoId,
            generatedAt: update?.generatedAt || new Date(),
            expiresAt: update?.expiresAt || create?.expiresAt,
            result: update?.result || create?.result,
            meta: update?.meta || create?.meta,
          };
          return state.cache;
        },
      },
    },
  },
});

// Mock do snapshot service — devolve snapshot pré-construído.
mock.module('../services/alunoInsightData.service.js', {
  namedExports: {
    buildAlunoInsightSnapshot: async () => state.snapshot,
  },
});

let svc;

function snapshotComDados() {
  return {
    janela: '4 semanas',
    consistencia: {
      streakAtual: 4, maximoHistorico: 4, semanasValidasUltimas4: 4,
      distribuicaoTreinos: { MUSCULACAO: 8, CORRIDA: 4 },
    },
    volume: {
      totalTreinosConcluidos: 12, atividadesStrava: 4,
      treinosPulados: 1, diasComAtividade: 14,
    },
    qualidade: { rpeMedioMusculacao: 7.2, matTimeBjjSegundos: null, readinessMedioBjj: null },
    marcos: {
      rpsNovos: 2,
      rpsDestaque: [{ exercicio: 'Supino', valor: 100, unidade: 'kg', reps: 5 }],
      conquistasDesbloqueadas: ['STREAK_4_SEMANAS'],
      totalConquistasAtivas: 2,
    },
    alvoProvaProximo: null,
    temDadosSuficientes: true,
  };
}

function llmReturning(input) {
  return {
    messages: {
      create: async () => ({
        content: [{ type: 'tool_use', name: 'submit_insight', input }],
      }),
    },
  };
}

before(async () => {
  svc = await import('../services/alunoInsight.service.js');
});

beforeEach(() => {
  state.aluno = { id: 'aluno-1', userId: 'user-aluno-1' };
  state.cache = null;
  state.upsertCalls = [];
  state.snapshot = snapshotComDados();
  svc.__resetClientForTests();
});

// ─── ACL / atalhos ──────────────────────────────────────────────────

describe('getWeeklyCheckin — atalhos', () => {
  it('temDadosSuficientes=false → atalho estático SEM tocar LLM', async () => {
    state.snapshot = { ...snapshotComDados(), temDadosSuficientes: false };
    let llmCalled = false;
    svc.__setClientForTests({
      messages: { create: async () => { llmCalled = true; return { content: [] }; } },
    });

    const out = await svc.getWeeklyCheckin({
      user: { userId: 'user-aluno-1', role: 'ALUNO' },
    });
    assert.equal(llmCalled, false);
    assert.equal(out.empty, true);
    assert.ok(out.result.summary.includes('Semana sem treinos'));
    assert.equal(out.result.origem, 'sem-dados');
    assert.equal(state.upsertCalls.length, 0, 'sem-dados NÃO persiste no DB');
  });

  it('cache hit (não expirado) → serve sem chamar LLM', async () => {
    state.cache = {
      id: 'ins-cached', alunoId: 'aluno-1',
      result: { summary: 'cached', destaques: [], origem: 'llm' },
      generatedAt: new Date(),
      expiresAt: new Date(Date.now() + 24 * 3600_000),
    };
    let llmCalled = false;
    svc.__setClientForTests({
      messages: { create: async () => { llmCalled = true; return { content: [] }; } },
    });

    const out = await svc.getWeeklyCheckin({
      user: { userId: 'user-aluno-1', role: 'ALUNO' },
    });
    assert.equal(llmCalled, false);
    assert.equal(out.fresh, true);
    assert.equal(out.result.summary, 'cached');
  });

  it('force=true bypassa cache válido e chama LLM', async () => {
    state.cache = {
      id: 'ins-cached', alunoId: 'aluno-1',
      result: { summary: 'cached', destaques: [], origem: 'llm' },
      generatedAt: new Date(),
      expiresAt: new Date(Date.now() + 24 * 3600_000),
    };
    svc.__setClientForTests(llmReturning({
      summary: 'Você fechou 4 semanas seguidas com 12 treinos concluídos. RPE médio em 7.2 indica adaptação.',
      destaques: [],
    }));

    const out = await svc.getWeeklyCheckin({
      user: { userId: 'user-aluno-1', role: 'ALUNO' },
      force: true,
    });
    assert.ok(out.result.summary.includes('12 treinos'));
  });
});

// ─── Happy path ─────────────────────────────────────────────────────

describe('getWeeklyCheckin — happy path', () => {
  it('LLM responde texto limpo → Zod passa, veto passa, persiste com origem llm', async () => {
    svc.__setClientForTests(llmReturning({
      summary: 'Você fechou 4 semanas seguidas com 12 treinos. Streak de 4 semanas e dois recordes pessoais marcados.',
      destaques: [
        'Primeiro recorde de musculação desbloqueado.',
        'Atividade em 14 dias diferentes.',
      ],
    }));

    const out = await svc.getWeeklyCheckin({
      user: { userId: 'user-aluno-1', role: 'ALUNO' },
    });
    assert.equal(out.fresh, true);
    assert.equal(out.empty, false);
    assert.equal(out.result.origem, 'llm');
    assert.equal(state.upsertCalls.length, 1);
    assert.equal(state.upsertCalls[0].create.meta.llmTentativas, 1);
    assert.equal(state.upsertCalls[0].create.meta.vetoBateu, false);
  });
});

// ─── Veto + regeneração ─────────────────────────────────────────────

describe('getWeeklyCheckin — veto + regeneração', () => {
  it('LLM viola na 1ª, passa na 2ª → resultado limpo, vetoBateu=false na meta', async () => {
    let n = 0;
    svc.__setClientForTests({
      messages: {
        create: async () => {
          n++;
          const input = n === 1
            ? {
                summary: 'Considere reduzir o volume pra recuperar melhor. Você está fadigado.',
                destaques: [],
              }
            : {
                summary: 'Você fechou 4 semanas seguidas com 12 treinos. RPE médio em 7.2 indica adaptação consistente.',
                destaques: ['Primeiro RP de musculação desbloqueado.'],
              };
          return { content: [{ type: 'tool_use', name: 'submit_insight', input }] };
        },
      },
    });

    const out = await svc.getWeeklyCheckin({
      user: { userId: 'user-aluno-1', role: 'ALUNO' },
    });
    assert.equal(out.result.origem, 'llm');
    assert.ok(!out.result.summary.includes('reduzir'));
    assert.equal(state.upsertCalls[0].create.meta.llmTentativas, 2);
    assert.equal(state.upsertCalls[0].create.meta.vetoBateu, false);
  });

  it('LLM viola 2x → fallback estático em código, origem=fallback-veto', async () => {
    svc.__setClientForTests({
      messages: {
        create: async () => ({
          content: [
            {
              type: 'tool_use',
              name: 'submit_insight',
              input: {
                summary: 'Recomendo que você considere reduzir o volume e cuide da hidratação.',
                destaques: ['Cuidado com lesão.'],
              },
            },
          ],
        }),
      },
    });

    const out = await svc.getWeeklyCheckin({
      user: { userId: 'user-aluno-1', role: 'ALUNO' },
    });
    assert.equal(out.result.origem, 'fallback-veto');
    // Texto estático usa números do snapshot real, sem termos vetados.
    assert.ok(out.result.summary.length >= 40);
    assert.ok(!out.result.summary.toLowerCase().includes('lesão'));
    assert.ok(!out.result.summary.toLowerCase().includes('recomendo'));
    assert.equal(state.upsertCalls[0].create.meta.vetoBateu, true);
  });
});

// ─── LLM falhas ─────────────────────────────────────────────────────

describe('getWeeklyCheckin — falhas de LLM', () => {
  it('LLM timeout + cache existe → stale fallback (sem 5xx)', async () => {
    state.cache = {
      id: 'ins-velho', alunoId: 'aluno-1',
      result: { summary: 'velho', destaques: [], origem: 'llm' },
      generatedAt: new Date(Date.now() - 30 * 24 * 3600_000),
      expiresAt: new Date(Date.now() - 7 * 24 * 3600_000),  // expirado
    };
    svc.__setClientForTests({
      messages: { create: async () => { throw new Error('ETIMEDOUT'); } },
    });

    const out = await svc.getWeeklyCheckin({
      user: { userId: 'user-aluno-1', role: 'ALUNO' },
    });
    assert.equal(out.stale, true);
    assert.equal(out.fresh, false);
    assert.equal(out.result.summary, 'velho');
  });

  it('LLM timeout SEM cache → fallback estático (NUNCA 5xx)', async () => {
    svc.__setClientForTests({
      messages: { create: async () => { throw new Error('ETIMEDOUT'); } },
    });

    const out = await svc.getWeeklyCheckin({
      user: { userId: 'user-aluno-1', role: 'ALUNO' },
    });
    assert.equal(out.result.origem, 'fallback-estatico');
    assert.ok(out.result.summary.length >= 40);
  });

  it('tool_use ausente + cache existe → stale', async () => {
    state.cache = {
      id: 'ins-velho', alunoId: 'aluno-1',
      result: { summary: 'velho', destaques: [], origem: 'llm' },
      generatedAt: new Date(),
      expiresAt: new Date(Date.now() - 1000),
    };
    svc.__setClientForTests({
      messages: { create: async () => ({ content: [{ type: 'text', text: 'sem tool' }] }) },
    });

    const out = await svc.getWeeklyCheckin({
      user: { userId: 'user-aluno-1', role: 'ALUNO' },
    });
    assert.equal(out.stale, true);
  });
});

// ─── Fallback estático em código ────────────────────────────────────

describe('construirInsightEstatico — texto sem veto', () => {
  it('snapshot rico produz texto factual com números', () => {
    const out = svc.__internal.construirInsightEstatico(snapshotComDados());
    assert.ok(out.summary.includes('4 semanas') || out.summary.includes('12 treino'));
    assert.equal(out.origem, 'fallback-estatico');
    // Confirma que NENHUM termo veto aparece no fallback estático.
    const corpus = (out.summary + ' ' + out.destaques.join(' ')).toLowerCase();
    const termosBanidos = ['recomendo', 'considere reduzir', 'lesão', 'estimativa de pace'];
    for (const t of termosBanidos) {
      assert.ok(!corpus.includes(t), `fallback estático deve evitar termo "${t}"`);
    }
  });

  it('snapshot vazio ainda produz summary com ≥40 chars (Zod-compatible)', () => {
    const snap = {
      janela: '4 semanas',
      consistencia: { streakAtual: 0, maximoHistorico: 0, semanasValidasUltimas4: 0, distribuicaoTreinos: {} },
      volume: { totalTreinosConcluidos: 0, atividadesStrava: 0, treinosPulados: 0, diasComAtividade: 0 },
      qualidade: { rpeMedioMusculacao: null, matTimeBjjSegundos: null, readinessMedioBjj: null },
      marcos: { rpsNovos: 0, rpsDestaque: [], conquistasDesbloqueadas: [], totalConquistasAtivas: 0 },
      alvoProvaProximo: null,
      temDadosSuficientes: false,
    };
    const out = svc.__internal.construirInsightEstatico(snap);
    assert.ok(out.summary.length >= 40);
    assert.ok(out.summary.length <= 400);
  });
});
