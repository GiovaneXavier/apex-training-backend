import { describe, it, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.VOICE_ENABLED = 'true';
process.env.ANTHROPIC_API_KEY = 'test-key-not-real';

const state = {
  professor: null,
  vinculos: [],
  alertas: [],
  cache: null,
  upserts: [],
};

mock.module('../lib/prisma.js', {
  namedExports: {
    prisma: {
      professor: {
        findUnique: async ({ where }) =>
          state.professor && where.userId === state.professor.userId ? state.professor : null,
      },
      vinculoProfessor: {
        findMany: async () => state.vinculos,
      },
      coachBriefing: {
        findUnique: async ({ where }) =>
          state.cache && state.cache.professorId === where.professorId ? state.cache : null,
        upsert: async ({ where, create, update }) => {
          state.upserts.push({ where, create, update });
          state.cache = {
            id: 'cb-1',
            professorId: where.professorId,
            ...(state.cache ? { ...update } : { ...create }),
            generatedAt: update?.generatedAt || new Date(),
            expiresAt: update?.expiresAt || create?.expiresAt,
            result: update?.result || create?.result,
          };
          return state.cache;
        },
      },
    },
  },
});

// Mock listAlertasProf — coach.service usa prisma.$queryRaw que não mockei.
mock.module('../services/coach.service.js', {
  namedExports: {
    listAlertasProf: async () => state.alertas,
  },
});

let svc;
let dataSvc;

before(async () => {
  svc = await import('../services/coachBriefing.service.js');
  dataSvc = await import('../services/coachBriefingData.service.js');
});

beforeEach(() => {
  state.professor = { id: 'prof-1', userId: 'user-prof-1' };
  state.vinculos = [];
  state.alertas = [];
  state.cache = null;
  state.upserts = [];
});

function makeAluno(id, nome, opts = {}) {
  return {
    aluno: {
      id,
      user: { nome },
      provas: opts.provas || [],
      planos: opts.planoAtivo ? [{ id: 'p-' + id }] : [],
      treinos: opts.modalidades?.map((m) => ({ modalidade: m })) || [],
    },
  };
}

function makeAlerta(alunoId, sev, tipo = 'INACTIVE_7D') {
  return {
    alunoId,
    alunoNome: 'Aluno',
    tipo,
    severidade: sev,
    detalhe: 'Sem atividade há 8 dias',
    modalidade: undefined,
    desde: new Date(Date.now() - 8 * 86400000).toISOString(),
  };
}

function llmMockReturning(toolInput) {
  return {
    messages: {
      create: async () => ({
        content: [
          { type: 'tool_use', name: 'submit_briefing', input: toolInput },
        ],
      }),
    },
  };
}

describe('buildBriefingSnapshot — agregador', () => {
  it('sem perfil de professor → estado neutro (vazio)', async () => {
    state.professor = null;
    const snap = await dataSvc.buildBriefingSnapshot({ userId: 'fantasma' });
    assert.equal(snap.professorId, null);
    assert.equal(snap.alunosVinculadosTotal, 0);
    assert.equal(snap.snapshots.length, 0);
  });

  it('encurta nome (privacidade)', async () => {
    state.vinculos = [makeAluno('a1', 'Carlos Eduardo Mendes')];
    const snap = await dataSvc.buildBriefingSnapshot({ userId: 'user-prof-1' });
    assert.equal(snap.snapshots[0].nome, 'Carlos M.');
  });

  it('alunos com alertas vêm primeiro (high antes de medium antes de sem-alerta)', async () => {
    state.vinculos = [
      makeAluno('a-clean', 'Joana'),
      makeAluno('a-low', 'Bruno'),
      makeAluno('a-high', 'Lucas'),
    ];
    state.alertas = [
      makeAlerta('a-low', 'low'),
      makeAlerta('a-high', 'high'),
    ];

    const snap = await dataSvc.buildBriefingSnapshot({ userId: 'user-prof-1' });
    assert.deepEqual(snap.snapshots.map((s) => s.alunoId), ['a-high', 'a-low', 'a-clean']);
  });

  it('cap em 50 alunos no prompt; residual contado separadamente', async () => {
    state.vinculos = Array.from({ length: 80 }, (_, i) => makeAluno(`a${i}`, `N${i}`));
    const snap = await dataSvc.buildBriefingSnapshot({ userId: 'user-prof-1' });
    assert.equal(snap.snapshots.length, 50);
    assert.equal(snap.alunosVinculadosTotal, 80);
    assert.equal(snap.alunosSemSnapshotResidual, 30);
  });

  it('pickProvaFutura só pega prova futura mais próxima', async () => {
    const passada = { nome: 'Velha', data: new Date(Date.now() - 86400000) };
    const proxima = { nome: 'Meia SP', data: new Date(Date.now() + 30 * 86400000) };
    const distante = { nome: 'Maratona', data: new Date(Date.now() + 200 * 86400000) };
    state.vinculos = [makeAluno('a1', 'X', { provas: [passada, distante, proxima] })];

    const snap = await dataSvc.buildBriefingSnapshot({ userId: 'user-prof-1' });
    assert.equal(snap.snapshots[0].proxProva.nome, 'Meia SP');
    assert.ok(snap.snapshots[0].proxProva.diasAte > 0);
  });
});

describe('coachBriefing.service — cache + LLM', () => {
  beforeEach(() => svc.__resetClientForTests());

  it('0 alunos vinculados → atalho sem chamar LLM', async () => {
    let llmCalled = false;
    svc.__setClientForTests({
      messages: { create: async () => { llmCalled = true; return { content: [] }; } },
    });

    const out = await svc.getBriefing({ user: { userId: 'user-prof-1', role: 'PROFESSOR' } });
    assert.equal(llmCalled, false);
    assert.equal(out.empty, true);
    assert.deepEqual(out.result.alunosEmAlerta, []);
  });

  it('cache hit → serve sem chamar LLM', async () => {
    state.vinculos = [makeAluno('a1', 'João')];
    state.cache = {
      id: 'cb', professorId: 'prof-1',
      result: { summary: 'cached', alunosEmAlerta: [], alunosBemEncaminhados: [] },
      generatedAt: new Date(),
      expiresAt: new Date(Date.now() + 3600_000),
    };

    let llmCalled = false;
    svc.__setClientForTests({
      messages: { create: async () => { llmCalled = true; return { content: [] }; } },
    });

    const out = await svc.getBriefing({ user: { userId: 'user-prof-1', role: 'PROFESSOR' } });
    assert.equal(llmCalled, false);
    assert.equal(out.fresh, true);
    assert.equal(out.result.summary, 'cached');
  });

  it('cache expirado → regenera via LLM', async () => {
    state.vinculos = [makeAluno('a1', 'João')];
    state.cache = {
      id: 'cb', professorId: 'prof-1',
      result: { summary: 'velho', alunosEmAlerta: [], alunosBemEncaminhados: [] },
      generatedAt: new Date(Date.now() - 48 * 3600_000),
      expiresAt: new Date(Date.now() - 24 * 3600_000),
    };

    svc.__setClientForTests(llmMockReturning({
      summary: 'Briefing fresco gerado pelo modelo de teste.',
      alunosEmAlerta: [],
      alunosBemEncaminhados: [{ alunoId: 'a1', motivo: 'Volume estável e treinos em dia.' }],
    }));

    const out = await svc.getBriefing({ user: { userId: 'user-prof-1', role: 'PROFESSOR' } });
    assert.equal(out.fresh, true);
    assert.ok(out.result.summary.includes('fresco'));
  });

  it('force=true bypassa cache válido', async () => {
    state.vinculos = [makeAluno('a1', 'João')];
    state.cache = {
      id: 'cb', professorId: 'prof-1',
      result: { summary: 'cached', alunosEmAlerta: [], alunosBemEncaminhados: [] },
      generatedAt: new Date(),
      expiresAt: new Date(Date.now() + 3600_000),
    };
    svc.__setClientForTests(llmMockReturning({
      summary: 'Forçado pelo refresh do coach manualmente.',
      alunosEmAlerta: [], alunosBemEncaminhados: [],
    }));

    const out = await svc.getBriefing({
      user: { userId: 'user-prof-1', role: 'PROFESSOR' },
      force: true,
    });
    assert.ok(out.result.summary.includes('Forçado'));
  });

  it('LLM falha + cache existe → stale fallback (sem 5xx)', async () => {
    state.vinculos = [makeAluno('a1', 'João')];
    state.cache = {
      id: 'cb', professorId: 'prof-1',
      result: { summary: 'cached-stale', alunosEmAlerta: [], alunosBemEncaminhados: [] },
      generatedAt: new Date(Date.now() - 48 * 3600_000),
      expiresAt: new Date(Date.now() - 24 * 3600_000),
    };
    svc.__setClientForTests({
      messages: { create: async () => { throw new Error('timeout'); } },
    });

    const out = await svc.getBriefing({ user: { userId: 'user-prof-1', role: 'PROFESSOR' } });
    assert.equal(out.stale, true);
    assert.equal(out.fresh, false);
    assert.equal(out.result.summary, 'cached-stale');
  });

  it('LLM falha SEM cache → propaga 504', async () => {
    state.vinculos = [makeAluno('a1', 'João')];
    svc.__setClientForTests({
      messages: { create: async () => { throw new Error('timeout'); } },
    });

    await assert.rejects(
      svc.getBriefing({ user: { userId: 'user-prof-1', role: 'PROFESSOR' } }),
      (e) => e.status === 504,
    );
  });

  it('fence: LLM cuspe alunoId fora do escopo → filtrado silenciosamente', async () => {
    state.vinculos = [makeAluno('a-real-1', 'João')];
    svc.__setClientForTests(llmMockReturning({
      summary: 'Aluno fantasma tentando se infiltrar no briefing alheio.',
      alunosEmAlerta: [
        { alunoId: 'a-fantasma-999', prioridade: 'alta', sinal: 'Sumiu', sugestaoAcao: 'Liga' },
        { alunoId: 'a-real-1', prioridade: 'media', sinal: 'Atraso', sugestaoAcao: 'Avisar' },
      ],
      alunosBemEncaminhados: [
        { alunoId: 'a-outro-coach-456', motivo: 'Volume bom' },
      ],
    }));

    const out = await svc.getBriefing({ user: { userId: 'user-prof-1', role: 'PROFESSOR' } });
    assert.equal(out.result.alunosEmAlerta.length, 1);
    assert.equal(out.result.alunosEmAlerta[0].alunoId, 'a-real-1');
    assert.equal(out.result.alunosBemEncaminhados.length, 0);
  });

  it('LLM tool_use ausente → 502', async () => {
    state.vinculos = [makeAluno('a1', 'João')];
    svc.__setClientForTests({
      messages: { create: async () => ({ content: [{ type: 'text', text: 'sem tool' }] }) },
    });

    await assert.rejects(
      svc.getBriefing({ user: { userId: 'user-prof-1', role: 'PROFESSOR' } }),
      (e) => e.status === 502,
    );
  });

  it('ALUNO chamando → 403', async () => {
    await assert.rejects(
      svc.getBriefing({ user: { userId: 'user-prof-1', role: 'ALUNO' } }),
      (e) => e.status === 403,
    );
  });

  it('upsert grava meta com alunosConsiderados', async () => {
    state.vinculos = [makeAluno('a1', 'X'), makeAluno('a2', 'Y')];
    svc.__setClientForTests(llmMockReturning({
      summary: 'Resumo curto válido pra teste.',
      alunosEmAlerta: [], alunosBemEncaminhados: [],
    }));

    await svc.getBriefing({ user: { userId: 'user-prof-1', role: 'PROFESSOR' } });
    assert.equal(state.upserts.length, 1);
    assert.equal(state.upserts[0].create.meta.alunosConsiderados, 2);
  });
});
