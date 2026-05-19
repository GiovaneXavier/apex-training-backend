import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@localhost:5432/test';

// Importamos o helper direto — não toca prisma nem env de push.
const triggers = await import('../lib/pushTriggers.js');
const {
  firePush,
  payloadNovoPlanoAlimentar,
  payloadNovoTreinoPrescrito,
  payloadNovoRecorde,
  __setDispatchForTests,
  __resetDispatchForTests,
} = triggers;

// queueMicrotask resolve no próximo tick. Usamos await new Promise(setImmediate)
// pra dar tempo de execução antes de assertar — equivalente a "drain microtasks".
function flushMicrotasks() {
  return new Promise((r) => setImmediate(r));
}

let consoleLogs = [];
let consoleWarns = [];
const realLog = console.log;
const realWarn = console.warn;

beforeEach(() => {
  consoleLogs = [];
  consoleWarns = [];
  console.log = (...args) => consoleLogs.push(args.join(' '));
  console.warn = (...args) => consoleWarns.push(args.join(' '));
});

afterEach(() => {
  console.log = realLog;
  console.warn = realWarn;
  __resetDispatchForTests();
});

describe('firePush — fire-and-forget + audit', () => {
  it('NÃO bloqueia o caller (resolve antes do dispatch executar)', async () => {
    let dispatchCalled = false;
    __setDispatchForTests(async () => {
      dispatchCalled = true;
      return { sent: 1, dead: 0, failed: 0 };
    });

    // firePush é sync — retorna sem await. Imediatamente após, dispatch
    // ainda não rodou (queueMicrotask só drena no próximo tick).
    firePush({ userId: 'u1', payload: payloadNovoTreinoPrescrito(), trigger: 't' });
    assert.equal(dispatchCalled, false, 'dispatch deve ser async via microtask');

    await flushMicrotasks();
    assert.equal(dispatchCalled, true);
  });

  it('audit log estruturado em stdout (JSON)', async () => {
    __setDispatchForTests(async () => ({ sent: 2, dead: 1, failed: 0 }));

    firePush({ userId: 'u-audit', payload: payloadNovoRecorde([{ exercicio: 'Supino' }]), trigger: 'novo-recorde' });
    await flushMicrotasks();

    assert.equal(consoleLogs.length, 1);
    const parsed = JSON.parse(consoleLogs[0]);
    assert.equal(parsed.msg, 'push-trigger');
    assert.equal(parsed.trigger, 'novo-recorde');
    assert.equal(parsed.userId, 'u-audit');
    assert.equal(parsed.sent, 2);
    assert.equal(parsed.dead, 1);
  });

  it('erro do dispatch NÃO propaga (try/catch silencia)', async () => {
    __setDispatchForTests(async () => { throw new Error('boom'); });

    let threw = false;
    try {
      firePush({ userId: 'u1', payload: payloadNovoTreinoPrescrito(), trigger: 't' });
    } catch {
      threw = true;
    }
    assert.equal(threw, false, 'firePush sync nunca lança');

    await flushMicrotasks();
    assert.equal(consoleWarns.length, 1);
    const parsed = JSON.parse(consoleWarns[0]);
    assert.equal(parsed.msg, 'push-trigger-failed');
    assert.equal(parsed.error, 'boom');
  });

  it('503 (push desabilitado) loga em debug, não warn', async () => {
    const err = new Error('disabled');
    err.status = 503;
    __setDispatchForTests(async () => { throw err; });

    firePush({ userId: 'u1', payload: payloadNovoTreinoPrescrito(), trigger: 't' });
    await flushMicrotasks();

    assert.equal(consoleWarns.length, 0, '503 não deve ir pra warn (poluição em dev)');
    assert.equal(consoleLogs.length, 1);
  });

  it('userId ausente → warn + skip dispatch', async () => {
    let dispatchCalled = false;
    __setDispatchForTests(async () => { dispatchCalled = true; });

    firePush({ userId: null, payload: payloadNovoTreinoPrescrito(), trigger: 't-noop' });
    await flushMicrotasks();

    assert.equal(dispatchCalled, false);
    assert.equal(consoleWarns.length, 1);
    assert.ok(consoleWarns[0].includes('t-noop'));
  });
});

describe('payloadNovoRecorde — agregação anti-flood', () => {
  it('1 RP → payload singular com nome do exercício', () => {
    const p = payloadNovoRecorde([{ exercicio: 'Supino Reto', valor: 100 }]);
    assert.ok(p.title.includes('Novo Recorde'));
    assert.ok(p.body.includes('Supino Reto'));
    assert.equal(p.url, '/aluno/rps');
    assert.equal(p.tag, 'rp-novo');
  });

  it('3 RPs → payload agregado com contagem', () => {
    const p = payloadNovoRecorde([
      { exercicio: 'Supino' }, { exercicio: 'Agachamento' }, { exercicio: 'Terra' },
    ]);
    assert.ok(p.title.includes('3 novos PRs'));
    assert.ok(!p.body.includes('Supino'), 'agregado não nomeia exercício específico');
  });

  it('0 RPs → null (no-op no caller)', () => {
    assert.equal(payloadNovoRecorde([]), null);
    assert.equal(payloadNovoRecorde(null), null);
    assert.equal(payloadNovoRecorde(undefined), null);
  });
});

describe('payload builders — copy estável', () => {
  it('plano alimentar tem url=/aluno/perfil e tag dedicada', () => {
    const p = payloadNovoPlanoAlimentar();
    assert.equal(p.url, '/aluno/perfil');
    assert.equal(p.tag, 'novo-plano-alimentar');
    assert.ok(p.title.length > 0);
  });

  it('novo treino tem url=/aluno/dashboard e tag dedicada', () => {
    const p = payloadNovoTreinoPrescrito();
    assert.equal(p.url, '/aluno/dashboard');
    assert.equal(p.tag, 'novo-treino');
  });
});
