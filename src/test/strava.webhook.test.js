import { describe, it, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';

// PR #41a (Sprint 15) — testes do endpoint público /api/strava/webhook.
// Foco crítico:
//   - GET hub.challenge: validar verify_token constant-time.
//   - POST eventos: idempotência (mesmo evento 2x não duplica), shape,
//     create/update/delete, owner desconhecido = ignore silencioso.
//
// Variáveis de webhook precisam ser setadas ANTES do import do index.js
// (env.js valida no boot). setup-env já setou as Strava OAuth básicas;
// completamos com VERIFY_TOKEN + CALLBACK_URL antes do app subir.

process.env.STRAVA_CLIENT_ID = process.env.STRAVA_CLIENT_ID || 'test-client';
process.env.STRAVA_CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET || 'test-secret';
process.env.STRAVA_REDIRECT_URI = process.env.STRAVA_REDIRECT_URI || 'http://localhost:5173/strava/callback';
process.env.STRAVA_VERIFY_TOKEN = 'verify-token-de-teste-fake-32-bytes';
process.env.STRAVA_WEBHOOK_CALLBACK_URL = 'https://test.example/api/strava/webhook';

// State mockado simulando o DB.
const state = {
  alunos: [
    { id: 'aluno-1', userId: 'user-1', stravaUserId: '987654', stravaToken: 'enc-token', stravaRefresh: 'enc-refresh', stravaExpiresAt: new Date(Date.now() + 3600_000) },
  ],
  atividades: [],
};

mock.module('../lib/prisma.js', {
  namedExports: {
    prisma: {
      aluno: {
        findFirst: async ({ where }) =>
          state.alunos.find((a) => where.stravaUserId && a.stravaUserId === where.stravaUserId) || null,
        update: async () => state.alunos[0],
      },
      atividadeStrava: {
        upsert: async ({ where, create, update }) => {
          const existing = state.atividades.find((a) => a.stravaId === where.stravaId);
          if (existing) {
            Object.assign(existing, update);
            return existing;
          }
          const fresh = { id: `act-${state.atividades.length + 1}`, ...create };
          state.atividades.push(fresh);
          return fresh;
        },
        deleteMany: async ({ where }) => {
          const before = state.atividades.length;
          state.atividades = state.atividades.filter(
            (a) => !(a.stravaId === where.stravaId && (!where.alunoId || a.alunoId === where.alunoId)),
          );
          return { count: before - state.atividades.length };
        },
      },
    },
  },
});

// Mock do fetchActivity (lib/strava) pra não bater na rede real.
const fetchActivityMock = mock.fn(async (_token, activityId) => ({
  id: Number(activityId),
  type: 'Run',
  name: 'Morning Run',
  distance: 5200,
  moving_time: 1800,
  average_speed: 2.89,
  average_heartrate: 152,
  start_date: '2026-08-29T07:00:00Z',
}));

// Mock dos helpers de crypto. Mantém safeEqual real (usado por csrf middleware)
// + isEncrypted; só simula encrypt/decrypt pra não exigir STRAVA_TOKEN_KEY real.
mock.module('../lib/crypto.js', {
  namedExports: {
    encrypt: (v) => `enc-${v}`,
    decrypt: (v) => (typeof v === 'string' ? v.replace(/^enc-/, '') : v),
    isEncrypted: () => true,
    // safeEqual real do node:crypto — constant-time compare. CSRF
    // middleware importa daqui; sem isso, boot do app quebra.
    safeEqual: (a, b) => {
      if (typeof a !== 'string' || typeof b !== 'string') return false;
      const cryptoMod = require('node:crypto');
      const bufA = Buffer.from(a, 'utf8');
      const bufB = Buffer.from(b, 'utf8');
      if (bufA.length !== bufB.length) return false;
      return cryptoMod.timingSafeEqual(bufA, bufB);
    },
  },
});

mock.module('../lib/strava.js', {
  namedExports: {
    exchangeCode: async () => ({}),
    refreshAccessToken: async () => ({}),
    fetchActivities: async () => [],
    fetchActivity: fetchActivityMock,
    listWebhookSubscriptions: async () => [],
    registerWebhookSubscription: async () => ({}),
    deleteWebhookSubscription: async () => ({}),
  },
});

let app;

before(async () => {
  ({ app } = await import('../index.js'));
});

beforeEach(() => {
  state.atividades = [];
  fetchActivityMock.mock.resetCalls();
});

// ─── GET /api/strava/webhook (hub.challenge validation) ──────────────
describe('GET /api/strava/webhook — hub.challenge', () => {
  it('200 com {hub.challenge} quando verify_token bate', async () => {
    const res = await request(app)
      .get('/api/strava/webhook')
      .query({
        'hub.mode': 'subscribe',
        'hub.verify_token': process.env.STRAVA_VERIFY_TOKEN,
        'hub.challenge': 'random-challenge-string-123',
      });
    assert.equal(res.status, 200);
    assert.equal(res.body['hub.challenge'], 'random-challenge-string-123');
  });

  it('403 quando verify_token errado', async () => {
    const res = await request(app)
      .get('/api/strava/webhook')
      .query({
        'hub.mode': 'subscribe',
        'hub.verify_token': 'token-totalmente-errado-fake-bytes',
        'hub.challenge': 'random-challenge-string-123',
      });
    assert.equal(res.status, 403);
  });

  it('400 quando faltam query params', async () => {
    const res = await request(app)
      .get('/api/strava/webhook')
      .query({ 'hub.mode': 'subscribe' });
    assert.equal(res.status, 400);
  });
});

// ─── POST /api/strava/webhook (event processing) ─────────────────────
describe('POST /api/strava/webhook — eventos', () => {
  it('200 + cria AtividadeStrava em evento create', async () => {
    const res = await request(app)
      .post('/api/strava/webhook')
      .send({
        object_type: 'activity',
        object_id: 12345678,
        aspect_type: 'create',
        owner_id: 987654,
        event_time: Math.floor(Date.now() / 1000),
      });
    assert.equal(res.status, 200);
    assert.equal(state.atividades.length, 1);
    assert.equal(state.atividades[0].stravaId, '12345678');
    assert.equal(state.atividades[0].nome, 'Morning Run');
    assert.equal(fetchActivityMock.mock.callCount(), 1);
  });

  it('idempotência: mesmo evento 2x = 1 atividade só', async () => {
    const payload = {
      object_type: 'activity',
      object_id: 12345678,
      aspect_type: 'create',
      owner_id: 987654,
    };
    await request(app).post('/api/strava/webhook').send(payload);
    await request(app).post('/api/strava/webhook').send(payload);
    assert.equal(state.atividades.length, 1);
  });

  it('update reatualiza payload sem duplicar', async () => {
    // create primeiro
    await request(app).post('/api/strava/webhook').send({
      object_type: 'activity', object_id: 12345678, aspect_type: 'create', owner_id: 987654,
    });
    assert.equal(state.atividades.length, 1);
    const original = state.atividades[0].sincronizadoEm;
    // update depois — fetchActivity simula nome diferente
    fetchActivityMock.mock.mockImplementation(async () => ({
      id: 12345678,
      type: 'Run',
      name: 'Morning Run RENAMED',
      distance: 5300,
      moving_time: 1800,
      average_speed: 2.94,
      average_heartrate: 150,
      start_date: '2026-08-29T07:00:00Z',
    }));
    await request(app).post('/api/strava/webhook').send({
      object_type: 'activity', object_id: 12345678, aspect_type: 'update', owner_id: 987654,
    });
    assert.equal(state.atividades.length, 1);
    assert.equal(state.atividades[0].nome, 'Morning Run RENAMED');
    assert.notEqual(state.atividades[0].sincronizadoEm, original);
  });

  it('delete remove atividade local', async () => {
    // Pre-popula
    state.atividades.push({
      id: 'act-x', alunoId: 'aluno-1', stravaId: '99999', tipo: 'Run', nome: 'X',
    });
    const res = await request(app).post('/api/strava/webhook').send({
      object_type: 'activity', object_id: 99999, aspect_type: 'delete', owner_id: 987654,
    });
    assert.equal(res.status, 200);
    assert.equal(state.atividades.length, 0);
  });

  it('owner desconhecido = ack silencioso (200, sem persistir)', async () => {
    const res = await request(app).post('/api/strava/webhook').send({
      object_type: 'activity', object_id: 11111, aspect_type: 'create',
      owner_id: 'owner-que-nao-conectou',
    });
    assert.equal(res.status, 200);
    assert.equal(state.atividades.length, 0);
    assert.equal(fetchActivityMock.mock.callCount(), 0, 'não deve nem fazer fetch');
  });

  it('object_type != activity = ignore', async () => {
    const res = await request(app).post('/api/strava/webhook').send({
      object_type: 'athlete', object_id: 987654, aspect_type: 'update', owner_id: 987654,
      updates: { authorized: 'false' },
    });
    assert.equal(res.status, 200);
    assert.equal(state.atividades.length, 0);
    assert.equal(fetchActivityMock.mock.callCount(), 0);
  });

  it('payload malformado = 200 (não retentamos) + zero side-effects', async () => {
    // Strava nunca manda lixo, mas defensivo: erro interno responde 200
    // pra não acionar retry massivo.
    const res = await request(app).post('/api/strava/webhook').send({});
    assert.equal(res.status, 200);
    assert.equal(state.atividades.length, 0);
  });

  it('200 com body vazio (Strava espera) em todos os casos', async () => {
    const res = await request(app).post('/api/strava/webhook').send({
      object_type: 'activity', object_id: 12345678, aspect_type: 'create', owner_id: 987654,
    });
    assert.equal(res.status, 200);
    // body deve ser vazio ou tratável como tal — Strava ignora o corpo da resposta
    assert.ok(res.body === undefined || res.body === '' || Object.keys(res.body).length === 0);
  });
});
