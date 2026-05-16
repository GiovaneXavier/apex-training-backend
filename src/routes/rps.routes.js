import { Router } from 'express';

import { protect } from '../middleware/auth.middleware.js';
import { list } from '../controllers/rps.controller.js';

const router = Router();

router.get('/:alunoId', protect, list);

export default router;
