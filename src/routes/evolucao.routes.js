import { Router } from 'express';
import { protect } from '../middleware/auth.middleware.js';
import { list, getOne, create, update, remove, preview } from '../controllers/evolucao.controller.js';

const router = Router();

// Pré-visualização do cálculo (sem persistir) — útil pra UI em tempo real
router.post('/preview', protect, preview);

router.get('/', protect, list);
router.get('/:id', protect, getOne);
router.post('/', protect, create);
router.put('/:id', protect, update);
router.delete('/:id', protect, remove);

export default router;
