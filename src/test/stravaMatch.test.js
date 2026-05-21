import { describe, it, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// PR #41b — testes do motor de match. Mocka prisma; testa orquestração + guards.

const state = {
  // tabelas mockadas
  treinos: [],
  sugestoes: [],
  matchRejeitados: [],
  atividadesStrava: [],
  alunos: [],
  // efeitos colaterais capturados
  treinoUpdates: [],
  sugestoesCriadas: [],
  matchRejeitadosCriados: [],
  sugestoesAtualizadas: [],
  sugestoesAtualizadasEmMassa: [],
};

function resetState() {
  state.treinos = [];
  state.sugestoes = [];
  state.matchRejeitados = [];
  state.atividadesStrava = [];
  state.alunos = [];
  state.treinoUpdates = [];
  state.sugestoesCriadas = [];
  state.matchRejeitadosCriados = [];
  state.sugestoesAtualizadas = [];
  state.sugestoesAtualizadasEmMassa = [];
}

mock.module('../lib/prisma.js', {
  namedExports: {
    prisma: {
      treino: {
        findMany: async ({ where }) => {
          return state.treinos.filter((t) => {
            if (where.alunoId && t.alunoId !== where.alunoId) return false;
            if (where.stravaActivityId === null && t.stravaActivityId != null) return false;
            if (where.dataAlvo?.gte && t.dataAlvo < where.dataAlvo.gte) return false;
            if (where.dataAlvo?.lte && t.dataAlvo > where.dataAlvo.lte) return false;
            return true;
          });
        },
        findUnique: async ({ where }) => {
          if (where.stravaActivityId !== undefined) {
            return state.treinos.find((t) => t.stravaActivityId === where.stravaActivityId) ?? null;
          }
          if (where.id) return state.treinos.find((t) => t.id === where.id) ?? null;
          return null;
        },
        update: async ({ where, data }) => {
          const t = state.treinos.find((x) => x.id === where.id);
          if (!t) throw new Error(`treino ${where.id} not found`);
          Object.assign(t, data);
          state.treinoUpdates.push({ id: where.id, data });
          return t;
        },
      },
      stravaSugestao: {
        findUnique: async ({ where }) => {
          if (where.atividadeStravaId) {
            return state.sugestoes.find((s) => s.atividadeStravaId === where.atividadeStravaId) ?? null;
          }
          if (where.id) return state.sugestoes.find((s) => s.id === where.id) ?? null;
          return null;
        },
        findMany: async ({ where }) => {
          return state.sugestoes.filter((s) => {
            if (where.alunoId && s.alunoId !== where.alunoId) return false;
            if (where.status && s.status !== where.status) return false;
            return true;
          });
        },
        create: async ({ data }) => {
          const s = { id: `sug_${state.sugestoes.length + 1}`, ...data };
          state.sugestoes.push(s);
          state.sugestoesCriadas.push(s);
          return s;
        },
        update: async ({ where, data }) => {
          const s = state.sugestoes.find((x) => x.id === where.id);
          if (!s) throw new Error(`sugestão ${where.id} not found`);
          Object.assign(s, data);
          state.sugestoesAtualizadas.push({ id: where.id, data });
          return s;
        },
        updateMany: async ({ where, data }) => {
          // implementação simplificada — checa OR de treinoId/atividadeStravaId
          const alvos = state.sugestoes.filter((s) => {
            if (where.id?.not && s.id === where.id.not) return false;
            if (where.status && s.status !== where.status) return false;
            if (where.OR) {
              return where.OR.some((cond) => {
                if (cond.treinoId && s.treinoId === cond.treinoId) return true;
                if (cond.atividadeStravaId && s.atividadeStravaId === cond.atividadeStravaId) return true;
                return false;
              });
            }
            return true;
          });
          alvos.forEach((s) => Object.assign(s, data));
          state.sugestoesAtualizadasEmMassa.push({ count: alvos.length, data });
          return { count: alvos.length };
        },
      },
      matchRejeitado: {
        findMany: async ({ where }) => {
          return state.matchRejeitados.filter((m) => {
            if (where.stravaActivityId && m.stravaActivityId !== where.stravaActivityId) return false;
            if (where.treinoId?.in && !where.treinoId.in.includes(m.treinoId)) return false;
            return true;
          });
        },
        upsert: async ({ where, create, update }) => {
          const key = where.treinoId_stravaActivityId;
          const existing = state.matchRejeitados.find(
            (m) => m.treinoId === key.treinoId && m.stravaActivityId === key.stravaActivityId,
          );
          if (existing) {
            Object.assign(existing, update);
            return existing;
          }
          const m = { id: `mr_${state.matchRejeitados.length + 1}`, ...create, criadoEm: new Date() };
          state.matchRejeitados.push(m);
          state.matchRejeitadosCriados.push(m);
          return m;
        },
      },
      atividadeStrava: {
        findMany: async ({ where }) => {
          return state.atividadesStrava.filter((a) => {
            if (where.alunoId && a.alunoId !== where.alunoId) return false;
            if (where.iniciadoEm?.gte && a.iniciadoEm < where.iniciadoEm.gte) return false;
            if (where.iniciadoEm?.lt && a.iniciadoEm >= where.iniciadoEm.lt) return false;
            if (where.NOT?.id && a.id === where.NOT.id) return false;
            return true;
          });
        },
      },
      aluno: {
        findUnique: async ({ where }) => {
          if (where.userId) return state.alunos.find((a) => a.userId === where.userId) ?? null;
          return null;
        },
      },
      $transaction: async (fn) => fn({
        treino: {
          update: async ({ where, data }) => {
            const t = state.treinos.find((x) => x.id === where.id);
            if (t) Object.assign(t, data);
            state.treinoUpdates.push({ id: where.id, data });
            return t;
          },
        },
        stravaSugestao: {
          update: async ({ where, data }) => {
            const s = state.sugestoes.find((x) => x.id === where.id);
            if (s) Object.assign(s, data);
            state.sugestoesAtualizadas.push({ id: where.id, data });
            return s;
          },
          updateMany: async ({ where, data }) => {
            const alvos = state.sugestoes.filter((s) => {
              if (where.id?.not && s.id === where.id.not) return false;
              if (where.status && s.status !== where.status) return false;
              if (where.OR) {
                return where.OR.some((cond) => {
                  if (cond.treinoId && s.treinoId === cond.treinoId) return true;
                  if (cond.atividadeStravaId && s.atividadeStravaId === cond.atividadeStravaId) return true;
                  return false;
                });
              }
              return true;
            });
            alvos.forEach((s) => Object.assign(s, data));
            state.sugestoesAtualizadasEmMassa.push({ count: alvos.length, data });
            return { count: alvos.length };
          },
        },
        matchRejeitado: {
          upsert: async ({ where, create, update }) => {
            const key = where.treinoId_stravaActivityId;
            const existing = state.matchRejeitados.find(
              (m) => m.treinoId === key.treinoId && m.stravaActivityId === key.stravaActivityId,
            );
            if (existing) {
              Object.assign(existing, update);
              return existing;
            }
            const m = { id: `mr_${state.matchRejeitados.length + 1}`, ...create, criadoEm: new Date() };
            state.matchRejeitados.push(m);
            state.matchRejeitadosCriados.push(m);
            return m;
          },
        },
      }),
    },
  },
});

let mod;
before(async () => {
  mod = await import('../services/stravaMatch.service.js');
});

beforeEach(() => resetState());

// ──────────────────────────────────────────────────────────────
// Fábricas
// ──────────────────────────────────────────────────────────────

function makeAtividade(over = {}) {
  return {
    id: 'ativ_1',
    stravaId: '99999',
    alunoId: 'aluno_1',
    tipo: 'Run',
    distanciaM: 10_000,
    duracaoSeg: 3_000,
    fcMedia: 155,
    iniciadoEm: new Date('2026-05-20T18:00:00Z'),
    ...over,
  };
}

function makeTreino(over = {}) {
  return {
    id: `treino_${state.treinos.length + 1}`,
    alunoId: 'aluno_1',
    stravaActivityId: null,
    modalidade: 'CORRIDA',
    dataAlvo: new Date('2026-05-20T09:00:00Z'),
    status: 'PENDENTE',
    finalizadoEm: null,
    detalhes: {
      tipo: 'corrida',
      distanciaKm: 10,
      duracaoSeg: 3_000,
      fcAlvoMin: 150,
      fcAlvoMax: 165,
    },
    ...over,
  };
}

// ──────────────────────────────────────────────────────────────
// extrairPrescricao (pure)
// ──────────────────────────────────────────────────────────────

describe('extrairPrescricao', () => {
  it('corrida km → metros', () => {
    const r = mod.extrairPrescricao({ detalhes: { distanciaKm: 10 } });
    assert.equal(r.distanciaPrescritaM, 10_000);
  });

  it('ciclismo min → seg', () => {
    const r = mod.extrairPrescricao({ detalhes: { duracaoMin: 60 } });
    assert.equal(r.duracaoPrescritaSeg, 3_600);
  });

  it('FC zone preserva', () => {
    const r = mod.extrairPrescricao({ detalhes: { fcAlvoMin: 140, fcAlvoMax: 160 } });
    assert.deepEqual(r.zonaFcAlvo, { min: 140, max: 160 });
  });

  it('musculação (sem dist/dur) → nulls', () => {
    const r = mod.extrairPrescricao({ detalhes: { tipo: 'musculacao' } });
    assert.equal(r.distanciaPrescritaM, null);
    assert.equal(r.duracaoPrescritaSeg, null);
  });

  it('natação por blocos soma série', () => {
    const r = mod.extrairPrescricao({
      detalhes: { blocos: [{ repeticoes: 10, distanciaM: 100 }] },
    });
    assert.equal(r.distanciaPrescritaM, 1000);
  });
});

// ──────────────────────────────────────────────────────────────
// matchAtividade
// ──────────────────────────────────────────────────────────────

describe('matchAtividade', () => {
  it('sem candidatos no dia → ignora silenciosamente', async () => {
    const out = await mod.matchAtividade(makeAtividade());
    assert.equal(out.acao, 'ignorado');
    assert.equal(out.motivo, 'sem_candidatos');
    assert.equal(state.sugestoesCriadas.length, 0);
    assert.equal(state.treinoUpdates.length, 0);
  });

  it('1 candidato score≥0.92 → Tier 1 (auto): atualiza Treino', async () => {
    state.treinos.push(makeTreino());
    const out = await mod.matchAtividade(makeAtividade());
    assert.equal(out.acao, 'auto_match');
    assert.equal(out.tier, 1);
    assert.ok(out.score >= 0.92);
    assert.equal(state.treinoUpdates.length, 1);
    assert.equal(state.treinoUpdates[0].data.stravaActivityId, '99999');
    assert.equal(state.treinoUpdates[0].data.status, 'CONCLUIDO');
    assert.equal(state.sugestoesCriadas.length, 0);
  });

  it('1 candidato score 0.65-0.91 → Tier 2 (sugestão)', async () => {
    // Distância +15% e duração +25% → score esperado 0.70..0.85
    state.treinos.push(makeTreino());
    const ativ = makeAtividade({ distanciaM: 11_500, duracaoSeg: 3_750 });
    const out = await mod.matchAtividade(ativ);
    assert.equal(out.acao, 'sugestao');
    assert.equal(out.tier, 2);
    assert.ok(out.score >= 0.65 && out.score < 0.92, `score esperado em [0.65, 0.92), recebido ${out.score}`);
    assert.equal(state.sugestoesCriadas.length, 1);
    assert.equal(state.sugestoesCriadas[0].status, 'PENDENTE');
    assert.equal(state.treinoUpdates.length, 0);
  });

  it('1 candidato score < 0.65 → ignora', async () => {
    // Mesmo dia (entra na janela) mas distância e duração 50% off → score < 0.65.
    state.treinos.push(makeTreino());
    const ativ = makeAtividade({ distanciaM: 5_000, duracaoSeg: 1_500 });
    const out = await mod.matchAtividade(ativ);
    assert.equal(out.acao, 'ignorado');
    assert.equal(out.motivo, 'score_baixo');
    assert.ok(out.score < 0.65);
    assert.equal(state.sugestoesCriadas.length, 0);
  });

  it('GUARD multi-match: 2 candidatos score≥0.92 → vira sugestão pro melhor', async () => {
    // Dois treinos idênticos no mesmo dia (perfeitos pra atividade)
    state.treinos.push(makeTreino({ id: 'treino_A' }));
    state.treinos.push(makeTreino({ id: 'treino_B' }));
    const out = await mod.matchAtividade(makeAtividade());
    assert.equal(out.acao, 'sugestao');
    assert.equal(out.motivo, 'multi_match_veto');
    assert.equal(out.tier, 2);
    assert.equal(state.treinoUpdates.length, 0, 'nenhum treino deve ser auto-vinculado');
    assert.equal(state.sugestoesCriadas.length, 1);
  });

  it('GUARD brick: Run+Ride no mesmo dia → força Tier 2', async () => {
    // Treino prescrito de corrida hoje
    state.treinos.push(makeTreino());
    // Aluno também pedalou no mesmo dia (atividade Strava separada)
    state.atividadesStrava.push({
      id: 'ativ_outra',
      alunoId: 'aluno_1',
      tipo: 'Ride',
      iniciadoEm: new Date('2026-05-20T07:00:00Z'),
    });
    const out = await mod.matchAtividade(makeAtividade());
    assert.equal(out.acao, 'sugestao');
    assert.equal(out.motivo, 'brick_veto');
    assert.equal(out.tier, 2);
    assert.equal(state.treinoUpdates.length, 0);
  });

  it('GUARD brick: Run+Treadmill (mesma modalidade) NÃO é brick', async () => {
    state.treinos.push(makeTreino());
    state.atividadesStrava.push({
      id: 'ativ_outra',
      alunoId: 'aluno_1',
      tipo: 'Treadmill',
      iniciadoEm: new Date('2026-05-20T07:00:00Z'),
    });
    const out = await mod.matchAtividade(makeAtividade());
    assert.equal(out.acao, 'auto_match', 'mesma modalidade não dispara brick guard');
  });

  it('GUARD cooldown: par (treino, activity) em MatchRejeitado → skip', async () => {
    state.treinos.push(makeTreino({ id: 'treino_X' }));
    state.matchRejeitados.push({
      id: 'mr_1',
      treinoId: 'treino_X',
      stravaActivityId: '99999',
      motivo: 'manual_reject',
    });
    const out = await mod.matchAtividade(makeAtividade());
    assert.equal(out.acao, 'ignorado');
    assert.equal(out.motivo, 'cooldown');
  });

  it('GUARD treino já com stravaActivityId → não é candidato', async () => {
    state.treinos.push(makeTreino({ stravaActivityId: 'outro_strava_id' }));
    const out = await mod.matchAtividade(makeAtividade());
    assert.equal(out.acao, 'ignorado');
    assert.equal(out.motivo, 'sem_candidatos');
  });

  it('GUARD sugestão já existe pra atividade → idempotência', async () => {
    state.treinos.push(makeTreino());
    state.sugestoes.push({
      id: 'sug_existente',
      atividadeStravaId: 'ativ_1',
      alunoId: 'aluno_1',
      treinoId: 'treino_1',
      score: 0.8,
      scoreBreakdown: {},
      status: 'PENDENTE',
    });
    const out = await mod.matchAtividade(makeAtividade());
    assert.equal(out.acao, 'ignorado');
    assert.equal(out.motivo, 'sugestao_ja_existe');
    assert.equal(state.sugestoesCriadas.length, 0);
  });

  it('GUARD treino já vinculado à mesma atividade Strava (UNIQUE) → idempotência', async () => {
    state.treinos.push(makeTreino({ id: 'treino_X', stravaActivityId: '99999' }));
    const out = await mod.matchAtividade(makeAtividade());
    assert.equal(out.acao, 'ignorado');
    assert.equal(out.motivo, 'treino_ja_vinculado');
  });

  it('chamar 2x mesma atividade → segunda chamada é no-op (idempotência via sugestão existente)', async () => {
    state.treinos.push(makeTreino({ distanciaKm: 11.5 })); // força Tier 2
    const ativ = makeAtividade({ distanciaM: 11_500, duracaoSeg: 3_750 });
    const out1 = await mod.matchAtividade(ativ);
    const out2 = await mod.matchAtividade(ativ);
    assert.equal(out1.acao, 'sugestao');
    assert.equal(out2.acao, 'ignorado');
    assert.equal(state.sugestoesCriadas.length, 1, 'apenas uma sugestão deve ter sido criada');
  });
});

// ──────────────────────────────────────────────────────────────
// aceitarSugestao
// ──────────────────────────────────────────────────────────────

describe('aceitarSugestao', () => {
  beforeEach(() => {
    state.alunos.push({ id: 'aluno_1', userId: 'user_1' });
  });

  it('atualiza Treino + sugestão, expira concorrentes', async () => {
    state.treinos.push(makeTreino({ id: 'treino_A' }));
    state.sugestoes.push({
      id: 'sug_target',
      alunoId: 'aluno_1',
      treinoId: 'treino_A',
      atividadeStravaId: 'ativ_1',
      score: 0.8,
      scoreBreakdown: {},
      status: 'PENDENTE',
      atividade: { stravaId: '99999' },
      treino: { finalizadoEm: null },
    });
    // Sugestão concorrente: mesmo treino, outra atividade
    state.sugestoes.push({
      id: 'sug_concorrente',
      alunoId: 'aluno_1',
      treinoId: 'treino_A',
      atividadeStravaId: 'ativ_2',
      score: 0.7,
      scoreBreakdown: {},
      status: 'PENDENTE',
    });

    const out = await mod.aceitarSugestao({ userId: 'user_1', sugestaoId: 'sug_target' });
    assert.equal(out.ok, true);

    const treino = state.treinos.find((t) => t.id === 'treino_A');
    assert.equal(treino.stravaActivityId, '99999');
    assert.equal(treino.status, 'CONCLUIDO');

    const sugTarget = state.sugestoes.find((s) => s.id === 'sug_target');
    assert.equal(sugTarget.status, 'ACEITA');

    const sugConcorrente = state.sugestoes.find((s) => s.id === 'sug_concorrente');
    assert.equal(sugConcorrente.status, 'EXPIRADA');
  });

  it('aluno tentando aceitar sugestão de outro → 403', async () => {
    state.sugestoes.push({
      id: 'sug_outro',
      alunoId: 'aluno_outro',
      treinoId: 'treino_x',
      atividadeStravaId: 'ativ_1',
      score: 0.8,
      status: 'PENDENTE',
      atividade: { stravaId: '99999' },
      treino: {},
    });
    await assert.rejects(
      () => mod.aceitarSugestao({ userId: 'user_1', sugestaoId: 'sug_outro' }),
      (e) => e.status === 403,
    );
  });

  it('sugestão já resolvida → 409', async () => {
    state.sugestoes.push({
      id: 'sug_aceita',
      alunoId: 'aluno_1',
      treinoId: 'treino_A',
      atividadeStravaId: 'ativ_1',
      score: 0.8,
      status: 'ACEITA',
      atividade: { stravaId: '99999' },
      treino: {},
    });
    await assert.rejects(
      () => mod.aceitarSugestao({ userId: 'user_1', sugestaoId: 'sug_aceita' }),
      (e) => e.status === 409,
    );
  });
});

// ──────────────────────────────────────────────────────────────
// rejeitarSugestao
// ──────────────────────────────────────────────────────────────

describe('rejeitarSugestao', () => {
  beforeEach(() => {
    state.alunos.push({ id: 'aluno_1', userId: 'user_1' });
  });

  it('marca REJEITADA + cria MatchRejeitado (motivo=manual_reject)', async () => {
    state.sugestoes.push({
      id: 'sug_1',
      alunoId: 'aluno_1',
      treinoId: 'treino_1',
      atividadeStravaId: 'ativ_1',
      score: 0.8,
      status: 'PENDENTE',
      atividade: { stravaId: '99999' },
    });
    const out = await mod.rejeitarSugestao({ userId: 'user_1', sugestaoId: 'sug_1' });
    assert.equal(out.ok, true);
    const sug = state.sugestoes.find((s) => s.id === 'sug_1');
    assert.equal(sug.status, 'REJEITADA');
    assert.equal(state.matchRejeitadosCriados.length, 1);
    assert.equal(state.matchRejeitadosCriados[0].motivo, 'manual_reject');
    assert.equal(state.matchRejeitadosCriados[0].stravaActivityId, '99999');
  });
});

// ──────────────────────────────────────────────────────────────
// desfazerMatch
// ──────────────────────────────────────────────────────────────

describe('desfazerMatch', () => {
  beforeEach(() => {
    state.alunos.push({ id: 'aluno_1', userId: 'user_1' });
  });

  it('zera vínculo + cria MatchRejeitado motivo=undone_tier1', async () => {
    state.treinos.push(makeTreino({ id: 'treino_X', stravaActivityId: '99999', status: 'CONCLUIDO' }));
    const out = await mod.desfazerMatch({ userId: 'user_1', treinoId: 'treino_X' });
    assert.equal(out.ok, true);
    const t = state.treinos.find((x) => x.id === 'treino_X');
    assert.equal(t.stravaActivityId, null);
    assert.equal(t.status, 'PENDENTE');
    assert.equal(state.matchRejeitadosCriados.length, 1);
    assert.equal(state.matchRejeitadosCriados[0].motivo, 'undone_tier1');
  });

  it('treino sem vínculo → 409', async () => {
    state.treinos.push(makeTreino({ id: 'treino_Y' }));
    await assert.rejects(
      () => mod.desfazerMatch({ userId: 'user_1', treinoId: 'treino_Y' }),
      (e) => e.status === 409,
    );
  });
});
