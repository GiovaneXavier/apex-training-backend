import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.middleware.js';
import { list, getOne, create, update, remove } from '../controllers/exercicio.controller.js';

const router = Router();

// Listar / obter — qualquer autenticado (professor, aluno, nutri)
router.get('/', requireAuth, list);
router.get('/:id', requireAuth, getOne);

// Mutação — apenas PROFESSOR
router.post('/', requireAuth, requireRole('PROFESSOR'), create);
router.put('/:id', requireAuth, requireRole('PROFESSOR'), update);
router.delete('/:id', requireAuth, requireRole('PROFESSOR'), remove);

export default router;
