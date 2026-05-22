import { describe, it, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@localhost:5432/test';
process.env.PUSH_ENABLED = 'true';
process.env.VAPID_PUBLIC_KEY = 'BPublic_FakeForTests____________';
process.env.VAPID_PRIVATE_KEY = 'Private_FakeForTests____________';

const state = { subs: [] };

mock.module('../lib/prisma.js', {
  namedExports: {
    prisma: {
      pushSubscription: {
        findMany: async ({ where }) =>
          where?.userId ? state.subs.filter((s) => s.userId === where.userId) : state.subs,
        deleteMany: async ({ where }) => {
          if (where?.endpoint && where?.userId) {
            const before = state.subs.length;
            state.subs = state.subs.filter(
              (s) => !(s.endpoint === where.endpoint && s.userId === where.userId),
            );
            return { count: before - state.subs.length };
          }
          return { count: 0 };
        },
        updateMany: async () => ({ count: 0 }),
        upsert: async ({ where, create, update }) => {
          const existing = state.subs.find((s) => s.endpoint === where.endpoint);
          if (existing) {
            Object.assign(existing, update);
            return existing;
          }
          const fresh = { id: `sub-${state.subs.length + 1}`, createdAt: new Date(), ...create };
          state.subs.push(fresh);
          return fresh;
        },
      },
    },
  },
});

let app;
let pushService;
let csrfToken;
let token;
const userId = 'user-push-1';

const SUB_PAYLOAD = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
  keys: {
    p256dh: 'BNNL7G7Z3Q2lAB3F4z5KZP9wX8jH-aN_KkLm_StuV4xy',
    auth: 'kjAa-bcDef0123456789',
  },
};

before(async () => {
  ({ app } = await import('../index.js'));
  pushService = await import('../services/push.service.js');
  // Web-push mockado pra teste do /test endpoint não bater rede real.
  pushService.__setWebPushForTests({
    sendNotification: async () => ({ statusCode: 201 }),
    setVapidDetails: () => {},
  });
  csrfToken = crypto.randomBytes(16).toString('hex');
  token = jwt.sign(
    { sub: userId, userId, role: 'ALUNO', csrf: csrfToken },
    process.env.JWT_SECRET,
    { expiresIn: '1h' },
  );
});

beforeEach(() => { state.subs = []; });

describe('GET /api/push/vapid-public-key — público', () => {
  it('200 sem auth, retorna a chave pública', async () => {
    const res = await request(app).get('/api/push/vapid-public-key');
    assert.equal(res.status, 200);
    assert.equal(res.body.key, process.env.VAPID_PUBLIC_KEY);
  });

  // PR #36 — hash SHA-256 base64url additivo, sem breaking change.
  it('200 inclui hash SHA-256 base64url que bate com a key', async () => {
    const res = await request(app).get('/api/push/vapid-public-key');
    assert.equal(res.status, 200);
    assert.ok(typeof res.body.hash === 'string' && res.body.hash.length > 0, 'hash presente');
    const expected = crypto
      .createHash('sha256')
      .update(process.env.VAPID_PUBLIC_KEY)
      .digest('base64url');
    assert.equal(res.body.hash, expected);
  });
});

describe('POST /api/push/subscriptions — autenticação + validação', () => {
  it('401 sem token', async () => {
    const res = await request(app).post('/api/push/subscriptions').send(SUB_PAYLOAD);
    assert.equal(res.status, 401);
  });

  it('403 sem CSRF', async () => {
    const res = await request(app)
      .post('/api/push/subscriptions')
      .set('Authorization', `Bearer ${token}`)
      .send(SUB_PAYLOAD);
    assert.equal(res.status, 403);
  });

  it('400 endpoint não-HTTPS', async () => {
    const res = await request(app)
      .post('/api/push/subscriptions')
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrfToken)
      .send({ ...SUB_PAYLOAD, endpoint: 'http://insecure.example/sub' });
    assert.equal(res.status, 400);
  });

  it('400 endpoint sem URL válida', async () => {
    const res = await request(app)
      .post('/api/push/subscriptions')
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrfToken)
      .send({ ...SUB_PAYLOAD, endpoint: 'not-a-url' });
    assert.equal(res.status, 400);
  });

  it('400 keys com campo desconhecido (.strict)', async () => {
    const res = await request(app)
      .post('/api/push/subscriptions')
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrfToken)
      .send({ ...SUB_PAYLOAD, keys: { ...SUB_PAYLOAD.keys, extra: 'lixo' } });
    assert.equal(res.status, 400);
  });

  it('201 happy path → grava userAgent do header se não vier no body', async () => {
    const res = await request(app)
      .post('/api/push/subscriptions')
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrfToken)
      .set('User-Agent', 'TestRunner/1.0')
      .send(SUB_PAYLOAD);
    assert.equal(res.status, 201);
    assert.equal(state.subs.length, 1);
    assert.equal(state.subs[0].userAgent, 'TestRunner/1.0');
    assert.equal(state.subs[0].userId, userId);
  });

  it('Re-submit do mesmo endpoint = upsert (idempotente)', async () => {
    await request(app)
      .post('/api/push/subscriptions')
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrfToken)
      .send(SUB_PAYLOAD);
    const res = await request(app)
      .post('/api/push/subscriptions')
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrfToken)
      .send(SUB_PAYLOAD);
    assert.equal(res.status, 201);
    assert.equal(state.subs.length, 1);
  });
});

describe('DELETE /api/push/subscriptions', () => {
  it('204 quando endpoint existe e pertence ao user', async () => {
    state.subs = [{
      id: 's1', userId, endpoint: SUB_PAYLOAD.endpoint, p256dh: 'p', auth: 'a',
    }];
    const res = await request(app)
      .delete('/api/push/subscriptions')
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrfToken)
      .send({ endpoint: SUB_PAYLOAD.endpoint });
    assert.equal(res.status, 204);
    assert.equal(state.subs.length, 0);
  });

  it('204 (idempotente) quando endpoint não existe', async () => {
    const res = await request(app)
      .delete('/api/push/subscriptions')
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrfToken)
      .send({ endpoint: 'https://fcm.googleapis.com/fcm/send/inexistente' });
    assert.equal(res.status, 204);
  });

  it('204 mas NÃO deleta sub de OUTRO user (cross-user safety)', async () => {
    state.subs = [{
      id: 's1', userId: 'outro-user', endpoint: SUB_PAYLOAD.endpoint, p256dh: 'p', auth: 'a',
    }];
    const res = await request(app)
      .delete('/api/push/subscriptions')
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrfToken)
      .send({ endpoint: SUB_PAYLOAD.endpoint });
    assert.equal(res.status, 204);
    assert.equal(state.subs.length, 1, 'sub do outro user deve permanecer');
  });
});

describe('POST /api/push/test (dev-only)', () => {
  it('200 dispara push fixture pro próprio user', async () => {
    state.subs = [{
      id: 's1', userId, endpoint: SUB_PAYLOAD.endpoint, p256dh: 'p', auth: 'a',
    }];
    const res = await request(app)
      .post('/api/push/test')
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrfToken)
      .send({});
    assert.equal(res.status, 200);
    assert.equal(res.body.sent, 1);
    assert.equal(res.body.dead, 0);
  });

  it('user sem subscription → 200 com sent:0', async () => {
    const res = await request(app)
      .post('/api/push/test')
      .set('Authorization', `Bearer ${token}`)
      .set('X-CSRF-Token', csrfToken)
      .send({});
    assert.equal(res.status, 200);
    assert.equal(res.body.sent, 0);
  });
});
