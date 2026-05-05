import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.middleware.js';
import {
  list, getOne, create, update, remove,
  doDia, iniciar, reagendar,
} from '../controllers/rotina.controller.js';

const router = Router();

// Aluno consulta rotinas do dia + dispara instância
router.get('/aluno/:alunoId/dia', requireAuth, doDia);
router.post('/:id/iniciar', requireAuth, requireRole('ALUNO'), iniciar);

// Aluno reagenda treino — endpoint sob /api/rotinas para manter o módulo contido
router.patch('/treinos/:id/reagendar', requireAuth, requireRole('ALUNO'), reagendar);

// Listar / get — qualquer autenticado
router.get('/', requireAuth, list);
router.get('/:id', requireAuth, getOne);

// Mutação — apenas PROFESSOR
router.post('/', requireAuth, requireRole('PROFESSOR'), create);
router.put('/:id', requireAuth, requireRole('PROFESSOR'), update);
router.delete('/:id', requireAuth, requireRole('PROFESSOR'), remove);

export default router;
