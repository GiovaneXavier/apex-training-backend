// PR #42 — Controllers do Cockpit Admin.
//
// Guard inline (ensureAdmin) em vez de requireRole — o requireRole faz
// BYPASS de ADMIN (deixa qualquer role com ADMIN passar) e aqui queremos
// exatamente o oposto: SÓ ADMIN entra. Cheque direto é mais claro que
// reescrever a semântica do middleware.

import { obterMetricasGlobais } from '../services/adminMetrics.service.js';
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
