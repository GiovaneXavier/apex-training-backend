import { Router } from 'express';

import { requireAuth } from '../middleware/auth.middleware.js';
import { listByAluno, criar, remover } from '../controllers/prova.controller.js';

const router = Router();

router.post('/', requireAuth, criar);
router.delete('/:id', requireAuth, remover);
router.get('/:alunoId', requireAuth, listByAluno);

export default router;
