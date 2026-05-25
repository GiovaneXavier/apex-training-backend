import { describe, it, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// PR #44 + #45 — vinculoOverride.service.
//
// Cobre transação atômica de vínculo + audit (agora via logAudit pós-tx
// do Bloco D, substituindo as antigas chamadas tx.vinculoAuditLog).

const state = {
  alunos: [],
  professores: [],
  vinculos: [],
  auditLogs: [], // capturado via mock do logAudit
  transactionCalls: 0,
};

function resetState() {
  state.alunos = [];
  state.professores = [];
  state.vinculos = [];
  state.auditLogs = [];
  state.transactionCalls = 0;
}

// Mock do helper de audit — captura chamadas síncronas (sem await),
// reflete que logAudit é fire-and-forget.
mock.module('../lib/auditLog.js', {
  namedExports: {
    AUDIT_ACTIONS: {
      VINCULO_CRIAR_PROF: 'vinculo.criar_prof',
      VINCULO_QUEBRAR_PROF: 'vinculo.quebrar_prof',
      USER_APROVAR: 'user.aprovar',
      USER_ATIVAR: 'user.ativar',
      USER_DESATIVAR: 'user.desativar',
      AUTH_LOGIN: 'auth.login',
      AUTH_LOGIN_FALHOU: 'auth.login_falhou',
      AUTH_LOGOUT: 'auth.logout',
    },
    logAudit: (entry) => {
      state.auditLogs.push(entry);
    },
    logAuditAndWait: async (entry) => {
      state.auditLogs.push(entry);
      return { id: 'mock', ...entry };
    },
  },
});

mock.module('../lib/prisma.js', {
  namedExports: {
    prisma: {
      aluno: {
        findUnique: async ({ where }) => state.alunos.find((a) => a.id === where.id) ?? null,
      },
      professor: {
        findUnique: async ({ where }) => state.professores.find((p) => p.id === where.id) ?? null,
      },
      vinculoProfessor: {
        findMany: async ({ where }) =>
          state.vinculos.filter((v) => v.alunoId === where.alunoId),
        deleteMany: async ({ where }) => {
          const before = state.vinculos.length;
          state.vinculos = state.vinculos.filter((v) => v.alunoId !== where.alunoId);
          return { count: before - state.vinculos.length };
        },
      },
      $transaction: async (fn) => {
        state.transactionCalls += 1;
        const tx = {
          vinculoProfessor: {
            deleteMany: async ({ where }) => {
              const ids = where.id?.in ?? [];
              const before = state.vinculos.length;
              state.vinculos = state.vinculos.filter((v) => !ids.includes(v.id));
              return { count: before - state.vinculos.length };
            },
            create: async ({ data, select }) => {
              const novo = { id: `v_${state.vinculos.length + 1}`, criadoEm: new Date(), ...data };
              state.vinculos.push(novo);
              if (!select) return novo;
              const out = {};
              for (const k of Object.keys(select)) if (select[k]) out[k] = novo[k];
              return out;
            },
          },
        };
        return fn(tx);
      },
    },
  },
});

let svc;
before(async () => {
  svc = await import('../services/vinculoOverride.service.js');
});

beforeEach(() => resetState());

function pushAluno({ id = 'a1', ativo = true } = {}) {
  state.alunos.push({ id, user: { ativo } });
}
function pushProfessor({ id = 'p1', ativo = true } = {}) {
  state.professores.push({ id, user: { ativo } });
}
function pushVinculo({ alunoId = 'a1', professorId = 'p1' } = {}) {
  const v = { id: `v_${state.vinculos.length + 1}`, alunoId, professorId };
  state.vinculos.push(v);
}

// ──────────────────────────────────────────────────────────────────────
// substituirVinculoProfessor — happy path + audit pós-tx (PR #45)
// ──────────────────────────────────────────────────────────────────────

describe('substituirVinculoProfessor — happy path', () => {
  it('aluno sem vínculo + prof ativo → cria 1 vínculo + 1 audit "criar"', async () => {
    pushAluno();
    pushProfessor();
    const out = await svc.substituirVinculoProfessor({
      alunoId: 'a1', professorId: 'p1', motivo: 'Atribuição inicial', atorUserId: 'admin1',
    });

    assert.equal(out.success, true);
    assert.equal(out.noop, false);
    assert.equal(out.removidos, 0);
    assert.equal(state.vinculos.length, 1);
    assert.equal(state.auditLogs.length, 1);
    assert.equal(state.auditLogs[0].action, 'vinculo.criar_prof');
    assert.equal(state.auditLogs[0].entityType, 'Aluno');
    assert.equal(state.auditLogs[0].entityId, 'a1');
    assert.equal(state.auditLogs[0].payload.professorId, 'p1');
    assert.equal(state.auditLogs[0].payload.motivo, 'Atribuição inicial');
    assert.equal(state.auditLogs[0].atorUserId, 'admin1');
  });

  it('aluno com vínculo p2 → quebra p2 e cria p1 (1 quebrar + 1 criar)', async () => {
    pushAluno();
    pushProfessor({ id: 'p1' });
    pushProfessor({ id: 'p2' });
    pushVinculo({ alunoId: 'a1', professorId: 'p2' });

    const out = await svc.substituirVinculoProfessor({
      alunoId: 'a1', professorId: 'p1', motivo: 'Troca', atorUserId: 'admin1',
    });

    assert.equal(out.removidos, 1);
    assert.equal(state.vinculos.length, 1);
    assert.equal(state.vinculos[0].professorId, 'p1');
    assert.equal(state.auditLogs.length, 2);
    assert.equal(state.auditLogs[0].action, 'vinculo.quebrar_prof');
    assert.equal(state.auditLogs[0].payload.professorId, 'p2');
    assert.equal(state.auditLogs[1].action, 'vinculo.criar_prof');
    assert.equal(state.auditLogs[1].payload.professorId, 'p1');
  });

  it('aluno com 3 vínculos legados → quebra todos + cria novo (3 + 1 audits)', async () => {
    pushAluno();
    pushProfessor({ id: 'p_new' });
    pushVinculo({ professorId: 'p_old1' });
    pushVinculo({ professorId: 'p_old2' });
    pushVinculo({ professorId: 'p_old3' });

    const out = await svc.substituirVinculoProfessor({
      alunoId: 'a1', professorId: 'p_new', atorUserId: 'admin1',
    });

    assert.equal(out.removidos, 3);
    assert.equal(state.vinculos.length, 1);
    assert.equal(state.auditLogs.length, 4);
  });

  it('motivo opcional ausente vira null no audit', async () => {
    pushAluno();
    pushProfessor();
    await svc.substituirVinculoProfessor({
      alunoId: 'a1', professorId: 'p1', atorUserId: 'admin1',
    });
    assert.equal(state.auditLogs[0].payload.motivo, null);
  });

  it('opera dentro de $transaction (atomicidade preservada)', async () => {
    pushAluno();
    pushProfessor();
    pushVinculo({ professorId: 'p_old' });
    await svc.substituirVinculoProfessor({
      alunoId: 'a1', professorId: 'p1', atorUserId: 'admin1',
    });
    assert.equal(state.transactionCalls, 1, 'transaction precisa ser chamada exatamente 1x');
  });

  it('audit captura ip/userAgent quando requestMeta vem (PR #45)', async () => {
    pushAluno();
    pushProfessor();
    await svc.substituirVinculoProfessor({
      alunoId: 'a1', professorId: 'p1', atorUserId: 'admin1',
      requestMeta: { ip: '192.168.1.1', userAgent: 'curl/8' },
    });
    assert.equal(state.auditLogs[0].ip, '192.168.1.1');
    assert.equal(state.auditLogs[0].userAgent, 'curl/8');
  });
});

// ──────────────────────────────────────────────────────────────────────
// substituirVinculoProfessor — idempotência (D2)
// ──────────────────────────────────────────────────────────────────────

describe('substituirVinculoProfessor — idempotência', () => {
  it('aluno já tem APENAS p1 → noop sem audit', async () => {
    pushAluno();
    pushProfessor();
    pushVinculo({ professorId: 'p1' });

    const out = await svc.substituirVinculoProfessor({
      alunoId: 'a1', professorId: 'p1', atorUserId: 'admin1',
    });

    assert.equal(out.noop, true);
    assert.equal(out.removidos, 0);
    assert.equal(state.transactionCalls, 0);
    assert.equal(state.auditLogs.length, 0);
    assert.equal(state.vinculos.length, 1);
  });

  it('aluno tem p1 + p2 (inconsistência legada) → NÃO é noop, reseta pra só p1', async () => {
    pushAluno();
    pushProfessor();
    pushVinculo({ professorId: 'p1' });
    pushVinculo({ professorId: 'p2' });

    const out = await svc.substituirVinculoProfessor({
      alunoId: 'a1', professorId: 'p1', atorUserId: 'admin1',
    });

    assert.equal(out.noop, false);
    assert.equal(out.removidos, 2);
    assert.equal(state.vinculos.length, 1);
    assert.equal(state.vinculos[0].professorId, 'p1');
  });

  it('chamadas repetidas (PUT idempotente) deixam estado consistente', async () => {
    pushAluno();
    pushProfessor();
    await svc.substituirVinculoProfessor({
      alunoId: 'a1', professorId: 'p1', atorUserId: 'admin1',
    });
    const out2 = await svc.substituirVinculoProfessor({
      alunoId: 'a1', professorId: 'p1', atorUserId: 'admin1',
    });
    assert.equal(out2.noop, true);
    assert.equal(state.vinculos.length, 1);
    assert.equal(state.auditLogs.length, 1, 'só o audit da primeira chamada');
  });
});

// ──────────────────────────────────────────────────────────────────────
// guards
// ──────────────────────────────────────────────────────────────────────

describe('substituirVinculoProfessor — guards', () => {
  it('aluno não encontrado → 404', async () => {
    pushProfessor();
    await assert.rejects(
      svc.substituirVinculoProfessor({ alunoId: 'fantasma', professorId: 'p1', atorUserId: 'admin1' }),
      (err) => err.status === 404 && /Aluno/.test(err.message),
    );
  });

  it('aluno inativo → 422', async () => {
    pushAluno({ ativo: false });
    pushProfessor();
    await assert.rejects(
      svc.substituirVinculoProfessor({ alunoId: 'a1', professorId: 'p1', atorUserId: 'admin1' }),
      (err) => err.status === 422 && /inativo/.test(err.message),
    );
  });

  it('professor não encontrado → 404', async () => {
    pushAluno();
    await assert.rejects(
      svc.substituirVinculoProfessor({ alunoId: 'a1', professorId: 'fantasma', atorUserId: 'admin1' }),
      (err) => err.status === 404 && /Professor/.test(err.message),
    );
  });

  it('professor inativo → 422', async () => {
    pushAluno();
    pushProfessor({ ativo: false });
    await assert.rejects(
      svc.substituirVinculoProfessor({ alunoId: 'a1', professorId: 'p1', atorUserId: 'admin1' }),
      (err) => err.status === 422 && /Professor.*inativo/.test(err.message),
    );
  });

  it('guard que falha NÃO gera audit (intenção não-consumada)', async () => {
    pushAluno({ ativo: false });
    pushProfessor();
    await assert.rejects(svc.substituirVinculoProfessor({
      alunoId: 'a1', professorId: 'p1', atorUserId: 'admin1',
    }));
    assert.equal(state.auditLogs.length, 0, 'falha de guard não pode gerar audit');
  });
});

// ──────────────────────────────────────────────────────────────────────
// removerVinculoProfessor
// ──────────────────────────────────────────────────────────────────────

describe('removerVinculoProfessor', () => {
  it('aluno com 2 vínculos → remove ambos + 2 audits "quebrar"', async () => {
    pushAluno();
    pushVinculo({ professorId: 'p1' });
    pushVinculo({ professorId: 'p2' });
    const out = await svc.removerVinculoProfessor({
      alunoId: 'a1', motivo: 'Saiu da plataforma', atorUserId: 'admin1',
    });
    assert.equal(out.removidos, 2);
    assert.equal(state.vinculos.length, 0);
    assert.equal(state.auditLogs.length, 2);
    assert.ok(state.auditLogs.every((l) => l.action === 'vinculo.quebrar_prof'));
    assert.ok(state.auditLogs.every((l) => l.payload.motivo === 'Saiu da plataforma'));
  });

  it('aluno sem vínculo → noop sem audit', async () => {
    pushAluno();
    const out = await svc.removerVinculoProfessor({
      alunoId: 'a1', atorUserId: 'admin1',
    });
    assert.equal(out.noop, true);
    assert.equal(out.removidos, 0);
    assert.equal(state.auditLogs.length, 0);
  });

  it('aluno não encontrado → 404', async () => {
    await assert.rejects(
      svc.removerVinculoProfessor({ alunoId: 'fantasma', atorUserId: 'admin1' }),
      (err) => err.status === 404,
    );
  });
});
