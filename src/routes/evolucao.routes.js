import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware.js';
import { list, getOne, create, update, remove, preview } from '../controllers/evolucao.controller.js';

const router = Router();

// Pré-visualização do cálculo (sem persistir) — útil pra UI em tempo real
router.post('/preview', requireAuth, preview);

router.get('/', requireAuth, list);
router.get('/:id', requireAuth, getOne);
router.post('/', requireAuth, create);
router.put('/:id', requireAuth, update);
router.delete('/:id', requireAuth, remove);

export default router;
