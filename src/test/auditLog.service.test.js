import { describe, it, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// PR #45 — auditLog.service: list paginado + filtros. Read-only.

const state = {
  logs: [], // { id, action, entityType, entityId, payload, atorUserId, criadoEm }
  lastWhere: null,
};

function resetState() {
  state.logs = [];
  state.lastWhere = null;
}

mock.module('../lib/prisma.js', {
  namedExports: {
    prisma: {
      auditLog: {
        findMany: async ({ where, orderBy, take }) => {
          state.lastWhere = where;
          let rows = [...state.logs];
          rows = applyWhere(rows, where);
          rows = applyOrderBy(rows, orderBy);
          return rows.slice(0, take).map((l) => ({
            ...l,
            ator: { id: l.atorUserId, nome: `Ator ${l.atorUserId}`, email: `${l.atorUserId}@x.com`, role: 'ADMIN' },
          }));
        },
      },
    },
  },
});

function applyWhere(rows, where) {
  if (!where) return rows;
  if (where.action) rows = rows.filter((l) => l.action === where.action);
  if (where.entityType) rows = rows.filter((l) => l.entityType === where.entityType);
  if (where.entityId) rows = rows.filter((l) => l.entityId === where.entityId);
  if (where.atorUserId) rows = rows.filter((l) => l.atorUserId === where.atorUserId);
  if (where.criadoEm?.gte) rows = rows.filter((l) => l.criadoEm >= where.criadoEm.gte);
  if (where.criadoEm?.lte) rows = rows.filter((l) => l.criadoEm <= where.criadoEm.lte);
  if (where.AND) {
    for (const clause of where.AND) {
      if (clause.OR) {
        rows = rows.filter((l) =>
          clause.OR.some((cond) => {
            if (cond.criadoEm?.lt) return l.criadoEm < cond.criadoEm.lt;
            if (cond.AND) {
              const a = cond.AND.find((x) => x.criadoEm)?.criadoEm;
              const i = cond.AND.find((x) => x.id)?.id;
              if (a && i?.lt) return +l.criadoEm === +a && l.id < i.lt;
            }
            return false;
          }),
        );
      }
    }
  }
  return rows;
}

function applyOrderBy(rows, orderBy) {
  if (!Array.isArray(orderBy)) return rows;
  return [...rows].sort((a, b) => {
    for (const clause of orderBy) {
      if (clause.criadoEm) {
        const dir = clause.criadoEm === 'desc' ? -1 : 1;
        const diff = (+a.criadoEm) - (+b.criadoEm);
        if (diff !== 0) return diff * dir;
      }
      if (clause.id) {
        const dir = clause.id === 'desc' ? -1 : 1;
        const cmp = a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        if (cmp !== 0) return cmp * dir;
      }
    }
    return 0;
  });
}

let svc;
before(async () => {
  svc = await import('../services/auditLog.service.js');
});

beforeEach(() => resetState());

function pushLog(over = {}) {
  const i = state.logs.length + 1;
  const l = {
    id: `log_${i}`,
    action: 'vinculo.criar_prof',
    entityType: 'Aluno',
    entityId: `a${i}`,
    payload: { professorId: `p${i}`, motivo: null },
    atorUserId: 'admin1',
    ip: null,
    userAgent: null,
    criadoEm: new Date(`2026-05-${10 + i}T10:00:00.000Z`),
    ...over,
  };
  state.logs.push(l);
  return l;
}

describe('listarAuditLogs — paginação', () => {
  it('lista vazia → {logs:[], proximoCursor:null, temMais:false}', async () => {
    const out = await svc.listarAuditLogs({ limit: 20 });
    assert.deepEqual(out.logs, []);
    assert.equal(out.proximoCursor, null);
    assert.equal(out.temMais, false);
  });

  it('limit=2 com 5 logs → 2 + cursor + temMais', async () => {
    for (let i = 0; i < 5; i++) pushLog();
    const out = await svc.listarAuditLogs({ limit: 2 });
    assert.equal(out.logs.length, 2);
    assert.equal(out.temMais, true);
    assert.ok(out.proximoCursor);
  });

  it('paginação entre páginas não repete nem pula', async () => {
    for (let i = 0; i < 6; i++) pushLog();
    const p1 = await svc.listarAuditLogs({ limit: 2 });
    const p2 = await svc.listarAuditLogs({ limit: 2, cursor: p1.proximoCursor });
    const p3 = await svc.listarAuditLogs({ limit: 2, cursor: p2.proximoCursor });
    const ids = [...p1.logs, ...p2.logs, ...p3.logs].map((l) => l.id);
    assert.equal(new Set(ids).size, 6);
  });

  it('ator é incluído via join leve', async () => {
    pushLog({ atorUserId: 'admin42' });
    const out = await svc.listarAuditLogs({ limit: 20 });
    assert.equal(out.logs[0].ator.id, 'admin42');
    assert.equal(out.logs[0].ator.role, 'ADMIN');
  });
});

describe('listarAuditLogs — filtros', () => {
  it('filtro action retorna só essa ação', async () => {
    pushLog({ action: 'vinculo.criar_prof' });
    pushLog({ action: 'vinculo.quebrar_prof' });
    pushLog({ action: 'user.aprovar' });
    const out = await svc.listarAuditLogs({ limit: 20, action: 'user.aprovar' });
    assert.equal(out.logs.length, 1);
    assert.equal(out.logs[0].action, 'user.aprovar');
  });

  it('filtro entityType + entityId — histórico de uma entidade', async () => {
    pushLog({ entityType: 'Aluno', entityId: 'a1' });
    pushLog({ entityType: 'Aluno', entityId: 'a2' });
    pushLog({ entityType: 'User', entityId: 'a1' });
    const out = await svc.listarAuditLogs({
      limit: 20, entityType: 'Aluno', entityId: 'a1',
    });
    assert.equal(out.logs.length, 1);
  });

  it('filtro atorUserId — ações de um admin específico', async () => {
    pushLog({ atorUserId: 'admin1' });
    pushLog({ atorUserId: 'admin2' });
    pushLog({ atorUserId: 'admin1' });
    const out = await svc.listarAuditLogs({ limit: 20, atorUserId: 'admin1' });
    assert.equal(out.logs.length, 2);
  });

  it('range desde/ate filtra por janela temporal', async () => {
    pushLog({ id: 'old', criadoEm: new Date('2026-04-01T00:00:00.000Z') });
    pushLog({ id: 'mid', criadoEm: new Date('2026-05-15T00:00:00.000Z') });
    pushLog({ id: 'new', criadoEm: new Date('2026-06-30T00:00:00.000Z') });
    const out = await svc.listarAuditLogs({
      limit: 20,
      desde: '2026-05-01T00:00:00.000Z',
      ate: '2026-06-01T00:00:00.000Z',
    });
    assert.equal(out.logs.length, 1);
    assert.equal(out.logs[0].id, 'mid');
  });

  it('cursor inválido → throw', async () => {
    await assert.rejects(
      svc.listarAuditLogs({ limit: 5, cursor: '!!!quebrado!!!' }),
      /cursor inválido/,
    );
  });
});
