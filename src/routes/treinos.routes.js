import { Router } from 'express';

import { protect } from '../middleware/auth.middleware.js';
import {
  listByAluno,
  detalhe,
  prescrever,
  salvarExecucao,
  remover,
  historico,
} from '../controllers/treino.controller.js';

const router = Router();

// Ordem importa: rotas estáticas antes de paramétricas para evitar colisão
router.post('/prescrever', protect, prescrever);
router.get('/historico-cargas', protect, historico);
router.get('/detalhe/:id', protect, detalhe);
router.post('/:id/salvar', protect, salvarExecucao);
router.delete('/:id', protect, remover);
router.get('/:alunoId', protect, listByAluno);

export default router;
