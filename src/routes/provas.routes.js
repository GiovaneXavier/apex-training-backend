import { Router } from 'express';

import { protect } from '../middleware/auth.middleware.js';
import {
  listByAluno,
  alvoByAluno,
  criar,
  atualizar,
  promover,
  arquivar,
  remover,
} from '../controllers/prova.controller.js';

const router = Router();

// PR #37 (Sprint 14) — Macro-ciclo Race A/B/C.
//
// Ordem das rotas importa: `/:alunoId/alvo` antes de `/:alunoId` pra que
// "alvo" não seja interpretado como alunoId.
router.post('/', protect, criar);
router.patch('/:id', protect, atualizar);
router.post('/:id/promover', protect, promover);
router.post('/:id/arquivar', protect, arquivar);
router.delete('/:id', protect, remover);
router.get('/:alunoId/alvo', protect, alvoByAluno);
router.get('/:alunoId', protect, listByAluno);

export default router;
