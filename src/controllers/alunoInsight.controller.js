import { getWeeklyCheckin } from '../services/alunoInsight.service.js';

// PR #32 — Aluno Weekly Check-in endpoints.
//
// GET /aluno/weekly-checkin          → cache-aware
// POST /aluno/weekly-checkin/refresh → force-regen (rate-limit 2/semana na rota)

function present(out) {
  return {
    result: out.result,
    generatedAt: out.generatedAt,
    expiresAt: out.expiresAt,
    fresh: out.fresh,
    stale: out.stale,
    empty: out.empty,
  };
}

export async function getAlunoWeeklyCheckin(req, res, next) {
  try {
    const out = await getWeeklyCheckin({
      user: req.user,
      alunoId: req.params.alunoId,
      force: false,
    });
    res.json(present(out));
  } catch (err) {
    next(err);
  }
}

export async function refreshAlunoWeeklyCheckin(req, res, next) {
  try {
    const out = await getWeeklyCheckin({
      user: req.user,
      alunoId: req.params.alunoId,
      force: true,
    });
    res.json(present(out));
  } catch (err) {
    next(err);
  }
}
