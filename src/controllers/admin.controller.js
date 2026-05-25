// PR #42 — Controllers do Cockpit Admin.
//
// Guard inline (ensureAdmin) em vez de requireRole — o requireRole faz
// BYPASS de ADMIN (deixa qualquer role com ADMIN passar) e aqui queremos
// exatamente o oposto: SÓ ADMIN entra. Cheque direto é mais claro que
// reescrever a semântica do middleware.

import { obterMetricasGlobais } from '../services/adminMetrics.service.js';
import {
  listarUsuarios,
  aprovarUsuario,
  atualizarStatusUsuario,
  obterDetalheUsuario,
} from '../services/adminUsers.service.js';
import {
  substituirVinculoProfessor,
  removerVinculoProfessor,
} from '../services/vinculoOverride.service.js';
import { listarProfessoresAtivos } from '../services/adminProfessores.service.js';
import { listarAuditLogs } from '../services/auditLog.service.js';
import {
  listUsersQuery,
  userIdParam,
  updateStatusBody,
  alunoIdParam,
  substituirVinculoBody,
  removerVinculoBody,
  listProfessoresQuery,
  listAuditQuery,
} from '../schemas/admin.schemas.js';
import { HttpError } from '../middleware/errorHandler.js';

function ensureAdmin(req) {
  if (req.user?.role !== 'ADMIN') {
    throw new HttpError(403, 'Acesso restrito ao administrador');
  }
}

export async function metricasGlobais(req, res, next) {
  try {
    ensureAdmin(req);
    const data = await obterMetricasGlobais();
    res.json(data);
  } catch (err) {
    next(err);
  }
}

// ──────────────────────────────────────────────────────────────────────
// PR #43 — Bloco B: Gerenciamento de Usuários
// ──────────────────────────────────────────────────────────────────────

export async function listUsuarios(req, res, next) {
  try {
    ensureAdmin(req);
    const filters = listUsersQuery.parse(req.query);
    const data = await listarUsuarios(filters);
    res.json(data);
  } catch (err) {
    next(err);
  }
}

export async function aprovarUsuarioCtrl(req, res, next) {
  try {
    ensureAdmin(req);
    const { id } = userIdParam.parse(req.params);
    const data = await aprovarUsuario({
      id,
      atorUserId: req.user.userId,
      requestMeta: requestMeta(req),
    });
    res.json(data);
  } catch (err) {
    next(err);
  }
}

export async function atualizarStatusCtrl(req, res, next) {
  try {
    ensureAdmin(req);
    const { id } = userIdParam.parse(req.params);
    const { ativo } = updateStatusBody.parse(req.body);
    const data = await atualizarStatusUsuario({
      id,
      ativo,
      atorUserId: req.user.userId,
      requestMeta: requestMeta(req),
    });
    res.json(data);
  } catch (err) {
    next(err);
  }
}

export async function detalheUsuarioCtrl(req, res, next) {
  try {
    ensureAdmin(req);
    const { id } = userIdParam.parse(req.params);
    const data = await obterDetalheUsuario({ id });
    res.json(data);
  } catch (err) {
    next(err);
  }
}

// ──────────────────────────────────────────────────────────────────────
// PR #44 — Bloco C: Overrides de vínculo Aluno↔Professor
// ──────────────────────────────────────────────────────────────────────

// Helper inline pra montar requestMeta (PR #45). Captura ip/userAgent
// pra audit log forense — sem isso, logs de override perdem origem.
function requestMeta(req) {
  return { ip: req.ip, userAgent: req.get('user-agent') };
}

export async function substituirVinculoCtrl(req, res, next) {
  try {
    ensureAdmin(req);
    const { alunoId } = alunoIdParam.parse(req.params);
    const { professorId, motivo } = substituirVinculoBody.parse(req.body);
    const data = await substituirVinculoProfessor({
      alunoId,
      professorId,
      motivo,
      atorUserId: req.user.userId,
      requestMeta: requestMeta(req),
    });
    res.json(data);
  } catch (err) {
    next(err);
  }
}

export async function removerVinculoCtrl(req, res, next) {
  try {
    ensureAdmin(req);
    const { alunoId } = alunoIdParam.parse(req.params);
    const { motivo } = removerVinculoBody.parse(req.body ?? {});
    const data = await removerVinculoProfessor({
      alunoId,
      motivo,
      atorUserId: req.user.userId,
      requestMeta: requestMeta(req),
    });
    res.json(data);
  } catch (err) {
    next(err);
  }
}

export async function listProfessoresAtivosCtrl(req, res, next) {
  try {
    ensureAdmin(req);
    const filters = listProfessoresQuery.parse(req.query);
    const data = await listarProfessoresAtivos(filters);
    res.json(data);
  } catch (err) {
    next(err);
  }
}

// PR #45 — Bloco D: Audit log viewer (read-only).
// Append-only é sagrado — não há controllers de create/update/delete.
export async function listAuditLogsCtrl(req, res, next) {
  try {
    ensureAdmin(req);
    const filters = listAuditQuery.parse(req.query);
    const data = await listarAuditLogs(filters);
    res.json(data);
  } catch (err) {
    next(err);
  }
}
