import { describe, it, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// PR #42 — Controller do Cockpit Admin.
//
// Cobre só o GUARD (ensureAdmin): payload em si é testado em
// adminMetrics.service.test.js. Foco aqui é garantir que role≠ADMIN
// nunca vê os números.

const state = { metricasCalled: 0 };

mock.module('../services/adminMetrics.service.js', {
  namedExports: {
    obterMetricasGlobais: async () => {
      state.metricasCalled += 1;
      return { geradoEm: '2026-05-27T17:00:00.000Z', usuarios: {}, treinos: {}, alertas: {} };
    },
  },
});

let metricasGlobais;
before(async () => {
  ({ metricasGlobais } = await import('../controllers/admin.controller.js'));
});

beforeEach(() => { state.metricasCalled = 0; });

function fakeRes() {
  return {
    status: function (c) { this.statusCode = c; return this; },
    json: function (b) { this.body = b; return this; },
  };
}

function expectNextCalledWithStatus(t, expected) {
  return (err) => {
    t.calls = (t.calls ?? 0) + 1;
    t.lastErr = err;
    assert.ok(err, 'next chamado sem erro');
    assert.equal(err.status, expected, `esperado status ${expected}, recebido ${err.status}`);
  };
}

describe('metricasGlobais — guard ensureAdmin', () => {
  it('ADMIN → 200 com payload', async () => {
    const req = { user: { role: 'ADMIN', userId: 'u1' } };
    const res = fakeRes();
    await metricasGlobais(req, res, () => assert.fail('next não deveria ser chamado'));
    assert.ok(res.body);
    assert.equal(res.body.geradoEm, '2026-05-27T17:00:00.000Z');
    assert.equal(state.metricasCalled, 1);
  });

  it('PROFESSOR → 403 sem tocar o service', async () => {
    const req = { user: { role: 'PROFESSOR', userId: 'u2' } };
    const t = {};
    await metricasGlobais(req, fakeRes(), expectNextCalledWithStatus(t, 403));
    assert.equal(state.metricasCalled, 0);
  });

  it('ALUNO → 403', async () => {
    const req = { user: { role: 'ALUNO', userId: 'u3' } };
    const t = {};
    await metricasGlobais(req, fakeRes(), expectNextCalledWithStatus(t, 403));
    assert.equal(state.metricasCalled, 0);
  });

  it('NUTRICIONISTA → 403', async () => {
    const req = { user: { role: 'NUTRICIONISTA', userId: 'u4' } };
    const t = {};
    await metricasGlobais(req, fakeRes(), expectNextCalledWithStatus(t, 403));
    assert.equal(state.metricasCalled, 0);
  });

  it('sem req.user → 403 (defensivo)', async () => {
    const t = {};
    await metricasGlobais({}, fakeRes(), expectNextCalledWithStatus(t, 403));
    assert.equal(state.metricasCalled, 0);
  });
});
