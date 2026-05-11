import { Router } from 'express';
import { protect, requireRole } from '../middleware/auth.middleware.js';
import { list, getOne, create, update, remove } from '../controllers/exercicio.controller.js';

const router = Router();

// Listar / obter — qualquer autenticado (professor, aluno, nutri)
router.get('/', protect, list);
router.get('/:id', protect, getOne);

// Mutação — apenas PROFESSOR
router.post('/', protect, requireRole('PROFESSOR'), create);
router.put('/:id', protect, requireRole('PROFESSOR'), update);
router.delete('/:id', protect, requireRole('PROFESSOR'), remove);

export default router;
