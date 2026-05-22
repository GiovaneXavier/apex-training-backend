import { describe, it, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// Env precisa estar antes do import do env.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@localhost:5432/test';
process.env.PUSH_ENABLED = 'true';
process.env.VAPID_PUBLIC_KEY = 'BTest_FakePublicKey_NotReal_____________';
process.env.VAPID_PRIVATE_KEY = 'TestPrivateKey_NotReal_______';
process.env.VAPID_SUBJECT = 'mailto:test@apex-training.local';

// Estado mutável do prisma mock.
const state = {
  subs: [],
  deleted: [],
  updated: [],
};

mock.module('../lib/prisma.js', {
  namedExports: {
    prisma: {
      pushSubscription: {
        findMany: async ({ where }) => {
          if (where?.userId) return state.subs.filter((s) => s.userId === where.userId);
          return state.subs;
        },
        deleteMany: async ({ where }) => {
          if (where?.id?.in) {
            state.deleted.push(...where.id.in);
            const before = state.subs.length;
            state.subs = state.subs.filter((s) => !where.id.in.includes(s.id));
            return { count: before - state.subs.length };
          }
          if (where?.endpoint && where?.userId) {
            const before = state.subs.length;
            state.subs = state.subs.filter(
              (s) => !(s.endpoint === where.endpoint && s.userId === where.userId),
            );
            return { count: before - state.subs.length };
          }
          return { count: 0 };
        },
        updateMany: async ({ where, data }) => {
          if (where?.id?.in) {
            state.updated.push({ ids: where.id.in, data });
            return { count: where.id.in.length };
          }
          return { count: 0 };
        },
        upsert: async ({ where, create, update }) => {
          const existing = state.subs.find((s) => s.endpoint === where.endpoint);
          if (existing) {
            Object.assign(existing, update);
            return existing;
          }
          const fresh = {
            id: `sub-${state.subs.length + 1}`,
            createdAt: new Date(),
            ...create,
          };
          state.subs.push(fresh);
          return fresh;
        },
      },
    },
  },
});

let push;
before(async () => {
  push = await import('../services/push.service.js');
});

beforeEach(() => {
  state.subs = [];
  state.deleted = [];
  state.updated = [];
});

// ─── Mocks de webpush ───────────────────────────────────────────────

function webpushOk() {
  return {
    sendNotification: async () => ({ statusCode: 201 }),
    setVapidDetails: () => {},
  };
}

function webpushAllDead() {
  return {
    sendNotification: async () => {
      const err = new Error('Gone');
      err.statusCode = 410;
      throw err;
    },
    setVapidDetails: () => {},
  };
}

function webpushMixed() {
  // sub-1: ok, sub-2: 410 (dead), sub-3: 500 (transitório)
  let call = 0;
  return {
    sendNotification: async () => {
      call++;
      if (call === 1) return { statusCode: 201 };
      if (call === 2) { const e = new Error('Gone'); e.statusCode = 410; throw e; }
      if (call === 3) { const e = new Error('5xx'); e.statusCode = 503; throw e; }
      return { statusCode: 201 };
    },
    setVapidDetails: () => {},
  };
}

describe('push.service.dispatch — fan-out + cleanup', () => {
  it('user sem subscriptions → {sent:0, dead:0, failed:0}', async () => {
    push.__setWebPushForTests(webpushOk());
    const stats = await push.dispatch({
      userId: 'user-x',
      payload: { title: 'Oi', body: 'Mundo' },
    });
    assert.deepEqual(stats, { sent: 0, dead: 0, failed: 0 });
    push.__resetWebPushForTests();
  });

  it('fan-out: 3 subs, todas OK → sent:3, dead:0, lastUsedAt atualizado', async () => {
    state.subs = [
      { id: 's1', userId: 'u1', endpoint: 'https://fcm/1', p256dh: 'p1', auth: 'a1' },
      { id: 's2', userId: 'u1', endpoint: 'https://fcm/2', p256dh: 'p2', auth: 'a2' },
      { id: 's3', userId: 'u1', endpoint: 'https://fcm/3', p256dh: 'p3', auth: 'a3' },
    ];
    push.__setWebPushForTests(webpushOk());
    const stats = await push.dispatch({
      userId: 'u1',
      payload: { title: 'T', body: 'B', url: '/' },
    });
    assert.equal(stats.sent, 3);
    assert.equal(stats.dead, 0);
    assert.equal(stats.failed, 0);
    assert.equal(state.updated.length, 1);
    assert.deepEqual(state.updated[0].ids.sort(), ['s1', 's2', 's3']);
    push.__resetWebPushForTests();
  });

  it('410 Gone → sub deletada inline', async () => {
    state.subs = [
      { id: 's1', userId: 'u1', endpoint: 'https://fcm/dead', p256dh: 'p', auth: 'a' },
    ];
    push.__setWebPushForTests(webpushAllDead());
    const stats = await push.dispatch({
      userId: 'u1',
      payload: { title: 'T' },
    });
    assert.equal(stats.sent, 0);
    assert.equal(stats.dead, 1);
    assert.deepEqual(state.deleted, ['s1']);
    assert.equal(state.subs.length, 0);
    push.__resetWebPushForTests();
  });

  it('mix: 1 OK, 1 dead (410), 1 transitório (503) — allSettled, 1 sub limpa, 1 ainda viva', async () => {
    state.subs = [
      { id: 's1', userId: 'u1', endpoint: 'https://fcm/1', p256dh: 'p', auth: 'a' },
      { id: 's2', userId: 'u1', endpoint: 'https://fcm/2', p256dh: 'p', auth: 'a' },
      { id: 's3', userId: 'u1', endpoint: 'https://fcm/3', p256dh: 'p', auth: 'a' },
    ];
    push.__setWebPushForTests(webpushMixed());
    const stats = await push.dispatch({
      userId: 'u1',
      payload: { title: 'T' },
    });
    assert.equal(stats.sent, 1);
    assert.equal(stats.dead, 1);
    assert.equal(stats.failed, 1);
    // s2 deletada, s1 e s3 sobrevivem (s3 falhou transitório).
    assert.deepEqual(state.deleted, ['s2']);
    assert.equal(state.subs.length, 2);
    push.__resetWebPushForTests();
  });

  it('payload inválido rejeita ANTES de chamar webpush (Zod)', async () => {
    state.subs = [
      { id: 's1', userId: 'u1', endpoint: 'https://fcm/1', p256dh: 'p', auth: 'a' },
    ];
    let called = false;
    push.__setWebPushForTests({
      sendNotification: async () => { called = true; return { statusCode: 201 }; },
      setVapidDetails: () => {},
    });
    await assert.rejects(
      push.dispatch({ userId: 'u1', payload: { /* sem title */ body: 'só body' } }),
    );
    assert.equal(called, false);
    push.__resetWebPushForTests();
  });

  it('payload com campo desconhecido (.strict) → rejeita', async () => {
    push.__setWebPushForTests(webpushOk());
    await assert.rejects(
      push.dispatch({ userId: 'u1', payload: { title: 'T', extra: 'lixo' } }),
    );
    push.__resetWebPushForTests();
  });

  it('subscriptions de OUTRO user não recebem dispatch (escopo userId)', async () => {
    state.subs = [
      { id: 's1', userId: 'u-alice', endpoint: 'https://fcm/a', p256dh: 'p', auth: 'a' },
      { id: 's2', userId: 'u-bob', endpoint: 'https://fcm/b', p256dh: 'p', auth: 'a' },
    ];
    const sent = [];
    push.__setWebPushForTests({
      sendNotification: async (sub) => { sent.push(sub.endpoint); return { statusCode: 201 }; },
      setVapidDetails: () => {},
    });
    await push.dispatch({ userId: 'u-alice', payload: { title: 'T' } });
    assert.deepEqual(sent, ['https://fcm/a']);
    push.__resetWebPushForTests();
  });
});

describe('push.service — subscribe/unsubscribe', () => {
  it('saveSubscription cria nova entry', async () => {
    const sub = await push.saveSubscription({
      userId: 'u1', endpoint: 'https://fcm/new', p256dh: 'p', auth: 'a', userAgent: 'Chrome',
    });
    assert.equal(sub.endpoint, 'https://fcm/new');
    assert.equal(state.subs.length, 1);
  });

  it('saveSubscription com endpoint existente → upsert (não duplica)', async () => {
    await push.saveSubscription({ userId: 'u1', endpoint: 'https://fcm/x', p256dh: 'p1', auth: 'a1' });
    await push.saveSubscription({ userId: 'u1', endpoint: 'https://fcm/x', p256dh: 'p2', auth: 'a2' });
    assert.equal(state.subs.length, 1);
    assert.equal(state.subs[0].p256dh, 'p2');
  });

  it('deleteSubscription só remove se userId bater (anti-cross-user)', async () => {
    state.subs = [
      { id: 's1', userId: 'alice', endpoint: 'https://fcm/x', p256dh: 'p', auth: 'a' },
    ];
    const r1 = await push.deleteSubscription({ userId: 'bob', endpoint: 'https://fcm/x' });
    assert.equal(r1.count, 0);
    assert.equal(state.subs.length, 1);
    const r2 = await push.deleteSubscription({ userId: 'alice', endpoint: 'https://fcm/x' });
    assert.equal(r2.count, 1);
    assert.equal(state.subs.length, 0);
  });
});
