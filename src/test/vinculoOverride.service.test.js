import { describe, it, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// PR #44 — vinculoOverride.service.
//
// Cobre:
//  - substituirVinculoProfessor: transação atômica, audit log, idempotência,
//    todos os guards (aluno/prof inexistente, inativos).
//  - removerVinculoProfessor: idempotência, audit log gerado por vínculo
//    removido.

const state = {
  alunos: [], // { id, user: {ativo} }
  professores: [], // { id, user: {ativo} }
  vinculos: [], // { id, alunoId, professorId }
  auditLogs: [], // { acao, alunoId, professorId, motivo, atorUserId }
  // Telemetria de transação — pra confirmar atomicidade.
  transactionCalls: 0,
  inTransaction: false,
};

function resetState() {
  state.alunos = [];
  state.professores = [];
  state.vinculos = [];
  state.auditLogs = [];
  state.transactionCalls = 0;
  state.inTransaction = false;
}

// Mock prisma — operações usadas pelo service.
mock.module('../lib/prisma.js', {
  namedExports: {
    prisma: {
      aluno: {
        findUnique: async ({ where }) => {
          return state.alunos.find((a) => a.id === where.id) ?? null;
        },
      },
      professor: {
        findUnique: async ({ where }) => {
          return state.professores.find((p) => p.id === where.id) ?? null;
        },
      },
      vinculoProfessor: {
        findMany: async ({ where }) =>
          state.vinculos.filter((v) => v.alunoId === where.alunoId),
        // Não chamado fora de transaction no service — mas mantemos
        // pra completude do mock.
        deleteMany: async ({ where }) => {
          const before = state.vinculos.length;
          state.vinculos = state.vinculos.filter((v) => !where.id?.in?.includes(v.id));
          return { count: before - state.vinculos.length };
        },
      },
      vinculoAuditLog: {
        // Service usa só dentro de transaction; fora seria erro.
        createMany: async ({ data }) => {
          throw new Error('createMany não pode ser chamado fora de transaction');
        },
        create: async () => {
          throw new Error('create não pode ser chamado fora de transaction');
        },
      },
      $transaction: async (fn) => {
        state.transactionCalls += 1;
        state.inTransaction = true;
        const tx = {
          vinculoProfessor: {
            deleteMany: async ({ where }) => {
              const ids = where.id?.in ?? [];
              const matchAluno = where.alunoId ?? null;
              const before = state.vinculos.length;
              state.vinculos = state.vinculos.filter((v) => {
                if (matchAluno) return v.alunoId !== matchAluno;
                return !ids.includes(v.id);
              });
              return { count: before - state.vinculos.length };
            },
            create: async ({ data, select }) => {
              const novo = {
                id: `v_${state.vinculos.length + 1}`,
                criadoEm: new Date(),
                ...data,
              };
              state.vinculos.push(novo);
              if (!select) return novo;
              const out = {};
              for (const k of Object.keys(select)) if (select[k]) out[k] = novo[k];
              return out;
            },
          },
          vinculoAuditLog: {
            createMany: async ({ data }) => {
              state.auditLogs.push(...data);
              return { count: data.length };
            },
            create: async ({ data }) => {
              state.auditLogs.push(data);
              return { id: `log_${state.auditLogs.length}`, ...data };
            },
          },
        };
        try {
          const out = await fn(tx);
          return out;
        } finally {
          state.inTransaction = false;
        }
      },
    },
  },
});

let svc;
before(async () => {
  svc = await import('../services/vinculoOverride.service.js');
});

beforeEach(() => resetState());

// ──────────────────────────────────────────────────────────────────────
// Fábricas
// ──────────────────────────────────────────────────────────────────────

function pushAluno({ id = 'a1', ativo = true } = {}) {
  state.alunos.push({ id, user: { ativo } });
  return id;
}
function pushProfessor({ id = 'p1', ativo = true } = {}) {
  state.professores.push({ id, user: { ativo } });
  return id;
}
function pushVinculo({ alunoId = 'a1', professorId = 'p1' } = {}) {
  const v = { id: `v_${state.vinculos.length + 1}`, alunoId, professorId };
  state.vinculos.push(v);
  return v;
}

// ──────────────────────────────────────────────────────────────────────
// substituirVinculoProfessor — happy path + transação
// ──────────────────────────────────────────────────────────────────────

describe('substituirVinculoProfessor — happy path', () => {
  it('aluno sem vínculo + prof ativo → cria 1 vínculo + 1 audit', async () => {
    pushAluno();
    pushProfessor();
    const out = await svc.substituirVinculoProfessor({
      alunoId: 'a1', professorId: 'p1', motivo: 'Atribuição inicial', atorUserId: 'admin1',
    });

    assert.equal(out.success, true);
    assert.equal(out.noop, false);
    assert.equal(out.removidos, 0);
    assert.equal(state.vinculos.length, 1);
    assert.equal(state.vinculos[0].professorId, 'p1');
    assert.equal(state.auditLogs.length, 1);
    assert.equal(state.auditLogs[0].acao, 'criar_prof');
    assert.equal(state.auditLogs[0].motivo, 'Atribuição inicial');
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
    assert.equal(out.noop, false);
    assert.equal(state.vinculos.length, 1);
    assert.equal(state.vinculos[0].professorId, 'p1');
    // 1 quebrar (p2) + 1 criar (p1) = 2 audits
    assert.equal(state.auditLogs.length, 2);
    assert.equal(state.auditLogs[0].acao, 'quebrar_prof');
    assert.equal(state.auditLogs[0].professorId, 'p2');
    assert.equal(state.auditLogs[1].acao, 'criar_prof');
    assert.equal(state.auditLogs[1].professorId, 'p1');
  });

  it('aluno com 3 vínculos legados → quebra todos + cria novo', async () => {
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
    assert.equal(state.vinculos[0].professorId, 'p_new');
    // 3 quebrar + 1 criar
    assert.equal(state.auditLogs.length, 4);
  });

  it('motivo opcional (D7) — ausente vira null no audit', async () => {
    pushAluno();
    pushProfessor();
    await svc.substituirVinculoProfessor({
      alunoId: 'a1', professorId: 'p1', atorUserId: 'admin1',
    });
    assert.equal(state.auditLogs[0].motivo, null);
  });

  it('opera dentro de $transaction (atomicidade)', async () => {
    pushAluno();
    pushProfessor();
    pushVinculo({ professorId: 'p_old' });
    await svc.substituirVinculoProfessor({
      alunoId: 'a1', professorId: 'p1', atorUserId: 'admin1',
    });
    assert.equal(state.transactionCalls, 1, 'transaction precisa ser chamada exatamente 1x');
  });
});

// ──────────────────────────────────────────────────────────────────────
// substituirVinculoProfessor — idempotência (D2)
// ──────────────────────────────────────────────────────────────────────

describe('substituirVinculoProfessor — idempotência', () => {
  it('aluno já tem APENAS p1 como vínculo → noop sem audit', async () => {
    pushAluno();
    pushProfessor();
    pushVinculo({ professorId: 'p1' });

    const out = await svc.substituirVinculoProfessor({
      alunoId: 'a1', professorId: 'p1', atorUserId: 'admin1',
    });

    assert.equal(out.noop, true);
    assert.equal(out.removidos, 0);
    assert.equal(state.transactionCalls, 0, 'noop não deve abrir transaction');
    assert.equal(state.auditLogs.length, 0, 'noop não deve gerar audit');
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
    // Primeira chamada — cria
    await svc.substituirVinculoProfessor({
      alunoId: 'a1', professorId: 'p1', atorUserId: 'admin1',
    });
    // Segunda chamada — noop
    const out2 = await svc.substituirVinculoProfessor({
      alunoId: 'a1', professorId: 'p1', atorUserId: 'admin1',
    });
    assert.equal(out2.noop, true);
    assert.equal(state.vinculos.length, 1);
    assert.equal(state.auditLogs.length, 1, 'só o audit da primeira chamada');
  });
});

// ──────────────────────────────────────────────────────────────────────
// substituirVinculoProfessor — guards
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
});

// ──────────────────────────────────────────────────────────────────────
// removerVinculoProfessor
// ──────────────────────────────────────────────────────────────────────

describe('removerVinculoProfessor', () => {
  it('aluno com 2 vínculos → remove ambos + 2 audits', async () => {
    pushAluno();
    pushVinculo({ professorId: 'p1' });
    pushVinculo({ professorId: 'p2' });
    const out = await svc.removerVinculoProfessor({
      alunoId: 'a1', motivo: 'Saiu da plataforma', atorUserId: 'admin1',
    });
    assert.equal(out.removidos, 2);
    assert.equal(state.vinculos.length, 0);
    assert.equal(state.auditLogs.length, 2);
    assert.ok(state.auditLogs.every((l) => l.acao === 'quebrar_prof'));
    assert.ok(state.auditLogs.every((l) => l.motivo === 'Saiu da plataforma'));
  });

  it('aluno sem vínculo → noop sem audit nem transaction', async () => {
    pushAluno();
    const out = await svc.removerVinculoProfessor({
      alunoId: 'a1', atorUserId: 'admin1',
    });
    assert.equal(out.noop, true);
    assert.equal(out.removidos, 0);
    assert.equal(state.transactionCalls, 0);
    assert.equal(state.auditLogs.length, 0);
  });

  it('aluno não encontrado → 404', async () => {
    await assert.rejects(
      svc.removerVinculoProfessor({ alunoId: 'fantasma', atorUserId: 'admin1' }),
      (err) => err.status === 404,
    );
  });

  it('motivo opcional vira null no audit', async () => {
    pushAluno();
    pushVinculo({ professorId: 'p1' });
    await svc.removerVinculoProfessor({ alunoId: 'a1', atorUserId: 'admin1' });
    assert.equal(state.auditLogs[0].motivo, null);
  });
});
