import { describe, it, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// PR #45 — lib/auditLog.js: helper logAudit (fire-and-forget) + catálogo.
//
// Cobertura crítica: helper NUNCA pode propagar erro. Mesmo se prisma
// estiver morto, request continua. Falhas viram console.warn + Sentry.

const state = {
  createCalls: [],
  rejectNext: false,
  warnCalls: [],
};

function resetState() {
  state.createCalls = [];
  state.rejectNext = false;
  state.warnCalls = [];
}

mock.module('../lib/prisma.js', {
  namedExports: {
    prisma: {
      auditLog: {
        create: async ({ data }) => {
          state.createCalls.push(data);
          if (state.rejectNext) {
            state.rejectNext = false;
            throw new Error('DB caiu');
          }
          return { id: 'log_mock', ...data };
        },
      },
    },
  },
});

// Mock do Sentry pra não propagar nem quebrar quando não inicializado.
mock.module('../lib/sentry.js', {
  namedExports: {
    captureUnexpectedError: () => {},
    initSentry: () => {},
  },
});

let mod;
const originalWarn = console.warn;
before(async () => {
  mod = await import('../lib/auditLog.js');
  console.warn = (...args) => { state.warnCalls.push(args); };
});

beforeEach(() => resetState());

// Aguarda microtask seguinte pra fire-and-forget completar.
async function tick() {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('AUDIT_ACTIONS catálogo', () => {
  it('exporta as 8 ações canônicas do briefing', () => {
    assert.equal(mod.AUDIT_ACTIONS.VINCULO_CRIAR_PROF, 'vinculo.criar_prof');
    assert.equal(mod.AUDIT_ACTIONS.VINCULO_QUEBRAR_PROF, 'vinculo.quebrar_prof');
    assert.equal(mod.AUDIT_ACTIONS.USER_APROVAR, 'user.aprovar');
    assert.equal(mod.AUDIT_ACTIONS.USER_ATIVAR, 'user.ativar');
    assert.equal(mod.AUDIT_ACTIONS.USER_DESATIVAR, 'user.desativar');
    assert.equal(mod.AUDIT_ACTIONS.AUTH_LOGIN, 'auth.login');
    assert.equal(mod.AUDIT_ACTIONS.AUTH_LOGIN_FALHOU, 'auth.login_falhou');
    assert.equal(mod.AUDIT_ACTIONS.AUTH_LOGOUT, 'auth.logout');
  });

  it('é Object.freeze (imutável)', () => {
    assert.throws(() => {
      mod.AUDIT_ACTIONS.NOVA = 'algo';
    });
  });
});

describe('logAudit — fire-and-forget', () => {
  it('retorna void síncrono (não Promise)', () => {
    const r = mod.logAudit({
      action: 'test.x', entityType: 'X', entityId: '1', atorUserId: 'admin',
    });
    assert.equal(r, undefined, 'logAudit deve retornar undefined síncrono');
  });

  it('dispara create no Prisma com todos os campos', async () => {
    mod.logAudit({
      action: 'user.aprovar',
      entityType: 'User',
      entityId: 'u1',
      payload: { role: 'PROFESSOR' },
      atorUserId: 'admin1',
      ip: '10.0.0.1',
      userAgent: 'curl/8',
    });
    await tick();
    assert.equal(state.createCalls.length, 1);
    const call = state.createCalls[0];
    assert.equal(call.action, 'user.aprovar');
    assert.equal(call.entityType, 'User');
    assert.equal(call.entityId, 'u1');
    assert.deepEqual(call.payload, { role: 'PROFESSOR' });
    assert.equal(call.ip, '10.0.0.1');
    assert.equal(call.userAgent, 'curl/8');
  });

  it('payload/ip/userAgent ausentes viram null', async () => {
    mod.logAudit({
      action: 'test.x', entityType: 'X', entityId: '1', atorUserId: 'a',
    });
    await tick();
    assert.equal(state.createCalls[0].payload, null);
    assert.equal(state.createCalls[0].ip, null);
    assert.equal(state.createCalls[0].userAgent, null);
  });

  it('entry inválida (sem action) → ignora silenciosamente com warn', () => {
    mod.logAudit({ entityType: 'X', entityId: '1', atorUserId: 'a' });
    assert.equal(state.createCalls.length, 0);
    assert.ok(state.warnCalls.some((c) => /entry inválida/.test(c.join(' '))));
  });

  it('entry null → ignora sem crash', () => {
    assert.doesNotThrow(() => mod.logAudit(null));
    assert.equal(state.createCalls.length, 0);
  });

  it('Prisma falha → NÃO propaga (catch silencioso + warn)', async () => {
    state.rejectNext = true;
    mod.logAudit({
      action: 'test.x', entityType: 'X', entityId: '1', atorUserId: 'a',
    });
    await tick();
    // Falha logada mas nada explodiu — request seguiria fluindo.
    assert.ok(state.warnCalls.some((c) => /falha ao gravar/.test(c.join(' '))));
  });

  it('entityId convertido pra string (tolera number)', async () => {
    mod.logAudit({
      action: 'test.x', entityType: 'X', entityId: 42, atorUserId: 'a',
    });
    await tick();
    assert.equal(state.createCalls[0].entityId, '42');
    assert.equal(typeof state.createCalls[0].entityId, 'string');
  });
});

describe('logAuditAndWait — usado em testes/migrações', () => {
  it('retorna o registro criado', async () => {
    const out = await mod.logAuditAndWait({
      action: 'test.x', entityType: 'X', entityId: '1', atorUserId: 'a',
    });
    assert.equal(out.id, 'log_mock');
    assert.equal(out.action, 'test.x');
  });

  it('throw com campo obrigatório faltando', async () => {
    await assert.rejects(
      mod.logAuditAndWait({ entityType: 'X', entityId: '1', atorUserId: 'a' }),
      /obrigatórios/,
    );
  });
});
