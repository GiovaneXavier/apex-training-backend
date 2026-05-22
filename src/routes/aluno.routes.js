import { Router } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';

import { protect } from '../middleware/auth.middleware.js';
import {
  nutricionistas,
  aceitarNutri,
  recusarNutri,
  professores,
  desempenho,
  volume,
} from '../controllers/aluno.controller.js';
import { getStreak, listConquistas } from '../controllers/conquistas.controller.js';
import {
  getAlunoWeeklyCheckin,
  refreshAlunoWeeklyCheckin,
} from '../controllers/alunoInsight.controller.js';
import { REFRESH_LIMIT_PER_WEEK } from '../schemas/alunoInsight.schemas.js';

const router = Router();

router.use(protect);

router.get('/nutricionistas', nutricionistas);
router.post('/nutricionistas/:vinculoId/aceitar', aceitarNutri);
router.delete('/nutricionistas/:vinculoId', recusarNutri);
router.get('/professores', professores);

// Desempenho atlético agregado — alimenta a tab Desempenho do Progresso
router.get('/:alunoId/desempenho', desempenho);
router.get('/desempenho', desempenho); // ALUNO sem param — usa o próprio

// PR #20 — Matriz de Volume Semanal. Mesma ACL (resolveAlunoAccess
// no service). `?weeks=N` (4..52, default 12).
router.get('/:alunoId/volume', volume);
router.get('/volume', volume);

// PR #31 — Gamificação (Sprint 11). ALUNO usa rota sem param; PROFESSOR
// vinculado usa /:alunoId/. resolveAlunoAccess no service cuida da ACL.
router.get('/:alunoId/streak', getStreak);
router.get('/streak', getStreak);
router.get('/:alunoId/conquistas', listConquistas);
router.get('/conquistas', listConquistas);

// PR #32 — Aluno Weekly Check-in (Sprint 12). GET cache-aware (sem
// rate-limit estrito — serve do DB). POST refresh com cap semanal
// agressivo: cada regen toca LLM, custo precisa ser predicável.
router.get('/:alunoId/weekly-checkin', getAlunoWeeklyCheckin);
router.get('/weekly-checkin', getAlunoWeeklyCheckin);

const weeklyCheckinRefreshLimiter = rateLimit({
  windowMs: 7 * 24 * 60 * 60 * 1000, // 7 dias = 1 ciclo TTL
  max: REFRESH_LIMIT_PER_WEEK,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => {
    const uid = req.user?.userId;
    return uid ? `weekly-checkin|${uid}` : `weekly-checkin|ip|${ipKeyGenerator(req, res)}`;
  },
  message: {
    error: 'TooManyRequests',
    message: 'Limite semanal de atualização do insight atingido. Volte na próxima semana.',
  },
});

router.post('/:alunoId/weekly-checkin/refresh', weeklyCheckinRefreshLimiter, refreshAlunoWeeklyCheckin);
router.post('/weekly-checkin/refresh', weeklyCheckinRefreshLimiter, refreshAlunoWeeklyCheckin);

export default router;
