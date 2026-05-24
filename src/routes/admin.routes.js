import { Router } from 'express';

import { protect } from '../middleware/auth.middleware.js';
import { metricasGlobais } from '../controllers/admin.controller.js';

const router = Router();

router.use(protect);

// PR #42 — Cockpit Fase 1 (métricas globais).
router.get('/metrics', metricasGlobais);

export default router;
