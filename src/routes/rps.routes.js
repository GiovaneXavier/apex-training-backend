import { Router } from 'express';

import { requireAuth } from '../middleware/auth.middleware.js';
import { list } from '../controllers/rps.controller.js';

const router = Router();

router.get('/:alunoId', requireAuth, list);

export default router;
