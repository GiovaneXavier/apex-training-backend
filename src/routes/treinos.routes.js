import { Router } from 'express';

import { requireAuth } from '../middleware/auth.middleware.js';
import {
  listByAluno,
  detalhe,
  prescrever,
  salvarExecucao,
  remover,
} from '../controllers/treino.controller.js';

const router = Router();

// Ordem importa: rotas estáticas antes de paramétricas para evitar colisão
router.post('/prescrever', requireAuth, prescrever);
router.get('/detalhe/:id', requireAuth, detalhe);
router.post('/:id/salvar', requireAuth, salvarExecucao);
router.delete('/:id', requireAuth, remover);
router.get('/:alunoId', requireAuth, listByAluno);

export default router;
