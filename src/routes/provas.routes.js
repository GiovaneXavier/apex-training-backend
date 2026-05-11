import { Router } from 'express';

import { protect } from '../middleware/auth.middleware.js';
import { listByAluno, criar, remover } from '../controllers/prova.controller.js';

const router = Router();

router.post('/', protect, criar);
router.delete('/:id', protect, remover);
router.get('/:alunoId', protect, listByAluno);

export default router;
