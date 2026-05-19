import { getBriefing } from '../services/coachBriefing.service.js';

// PR #28 — Coach Briefing Semanal endpoints.
//
// GET /coach/briefing      → cache-aware, retorna {result, fresh, stale, ...}
// POST /coach/briefing/refresh → bypass cache (force regen), rate-limit 3/h.

function presentBriefing(out) {
  return {
    result: out.result,
    generatedAt: out.generatedAt,
    expiresAt: out.expiresAt,
    fresh: out.fresh,
    stale: out.stale,
    empty: out.empty,
    alunosVinculadosTotal: out.alunosVinculadosTotal,
    alunosResiduais: out.alunosResiduais,
  };
}

export async function getCoachBriefing(req, res, next) {
  try {
    const out = await getBriefing({ user: req.user, force: false });
    res.json(presentBriefing(out));
  } catch (err) {
    next(err);
  }
}

export async function refreshCoachBriefing(req, res, next) {
  try {
    const out = await getBriefing({ user: req.user, force: true });
    res.json(presentBriefing(out));
  } catch (err) {
    next(err);
  }
}
