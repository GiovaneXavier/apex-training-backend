import { Router } from 'express';

import { protect } from '../middleware/auth.middleware.js';
import { list, atual, create, update, remove } from '../controllers/plano.controller.js';

const router = Router();

router.use(protect);

// Ordem importa: rota paramétrica do "atual" tem que vir antes de :id.
router.get('/aluno/:alunoId/atual', atual);
router.get('/', list);
router.post('/', create);
router.patch('/:id', update);
router.delete('/:id', remove);

export default router;
