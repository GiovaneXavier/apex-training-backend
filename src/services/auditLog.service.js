// PR #45 (Sprint 16 — Bloco D) — Service de leitura do AuditLog.
//
// Único endpoint público (append-only é sagrado — sem create/update/
// delete via API). Lista paginada cursor-based reusando lib/cursor.
//
// Filtros opcionais (todos AND): action, entityType, entityId,
// atorUserId, desde, ate. Sem search livre — UI tem filtros tipados.
//
// Sort: criadoEm DESC (mais recente primeiro) + id DESC (empate-breaker).
// Mesmo padrão do listarUsuarios (Bloco B) — cursor estável.

import { prisma } from '../lib/prisma.js';
import { encodeCursor, decodeCursor } from '../lib/cursor.js';

const SELECT = {
  id: true,
  action: true,
  entityType: true,
  entityId: true,
  payload: true,
  atorUserId: true,
  ip: true,
  userAgent: true,
  criadoEm: true,
  // Join leve com ator pra UI mostrar nome/email sem N+1.
  ator: { select: { id: true, nome: true, email: true, role: true } },
};

export async function listarAuditLogs({
  limit, cursor, action, entityType, entityId, atorUserId, desde, ate,
}) {
  const where = {};
  if (action) where.action = action;
  if (entityType) where.entityType = entityType;
  if (entityId) where.entityId = entityId;
  if (atorUserId) where.atorUserId = atorUserId;
  if (desde || ate) {
    where.criadoEm = {};
    if (desde) where.criadoEm.gte = new Date(desde);
    if (ate) where.criadoEm.lte = new Date(ate);
  }

  // Cursor — mesma técnica do listarUsuarios (Bloco B).
  const decoded = cursor ? decodeCursor(cursor) : null;
  if (decoded?.lastCriadoEm && decoded?.lastId) {
    const lastDate = new Date(decoded.lastCriadoEm);
    const cursorFilter = {
      OR: [
        { criadoEm: { lt: lastDate } },
        { AND: [{ criadoEm: lastDate }, { id: { lt: decoded.lastId } }] },
      ],
    };
    where.AND = [...(where.AND ?? []), cursorFilter];
  }

  const rows = await prisma.auditLog.findMany({
    where,
    orderBy: [{ criadoEm: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    select: SELECT,
  });

  const temMais = rows.length > limit;
  const logs = temMais ? rows.slice(0, limit) : rows;
  const ultimo = logs[logs.length - 1];
  const proximoCursor = temMais && ultimo
    ? encodeCursor({
        lastCriadoEm: ultimo.criadoEm.toISOString(),
        lastId: ultimo.id,
      })
    : null;

  return { logs, proximoCursor, temMais };
}
