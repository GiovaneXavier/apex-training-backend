import { Router } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';

import { protect, requireRole } from '../middleware/auth.middleware.js';
import {
  getCoachBriefing,
  refreshCoachBriefing,
} from '../controllers/coachBriefing.controller.js';
import { postExerciseProgression } from '../controllers/aiProgression.controller.js';
import { RATE_LIMIT_PER_HOUR } from '../schemas/aiProgression.schemas.js';
import { postDraftTreino } from '../controllers/aiDraft.controller.js';
import { RATE_LIMIT_PER_HOUR as DRAFT_RATE_LIMIT } from '../schemas/aiDraft.schemas.js';

const router = Router();

// GET: cache-aware, sem rate-limit estrito (serve do DB; LLM só dispara
// quando expira). protect + role PROFESSOR.
router.get('/briefing', protect, requireRole('PROFESSOR'), getCoachBriefing);

// POST refresh: force-regen → custo LLM. Rate-limit 3/h/coach.
const refreshLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => {
    const uid = req.user?.userId;
    return uid ? `coach-briefing|${uid}` : `coach-briefing|ip|${ipKeyGenerator(req, res)}`;
  },
  message: {
    error: 'TooManyRequests',
    message: 'Limite de atualização do briefing atingido (3/h). Espere antes de regenerar.',
  },
});

router.post(
  '/briefing/refresh',
  protect,
  requireRole('PROFESSOR'),
  refreshLimiter,
  refreshCoachBriefing,
);

// PR #29 — AI Progression Suggestion (1 exercício, 1 aluno).
// Rate-limit 30/h/coach: cobre montagem de rotina inteira + retries
// naturais, agressivo contra scraper.
const aiProgressionLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: RATE_LIMIT_PER_HOUR,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => {
    const uid = req.user?.userId;
    return uid ? `ai-progression|${uid}` : `ai-progression|ip|${ipKeyGenerator(req, res)}`;
  },
  message: {
    error: 'TooManyRequests',
    message: 'Limite de sugestões IA atingido (30/h). Tente em alguns minutos.',
  },
});

router.post(
  '/ai-progression/exercise',
  protect,
  requireRole('PROFESSOR'),
  aiProgressionLimiter,
  postExerciseProgression,
);

// PR #30 — AI Plan Drafting (geração de esqueleto de rotina).
// Rate-limit 10/h/coach: ação pesada (~5-8s LLM), não rajada. Mais
// agressivo que progression suggestion (30/h) porque cada draft custa
// ~6x mais tokens.
const aiDraftLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: DRAFT_RATE_LIMIT,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => {
    const uid = req.user?.userId;
    return uid ? `ai-draft|${uid}` : `ai-draft|ip|${ipKeyGenerator(req, res)}`;
  },
  message: {
    error: 'TooManyRequests',
    message: 'Limite de gerações IA atingido (10/h). Tente em alguns minutos.',
  },
});

router.post(
  '/ai-draft/treino',
  protect,
  requireRole('PROFESSOR'),
  aiDraftLimiter,
  postDraftTreino,
);

export default router;
