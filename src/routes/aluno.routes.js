import { Router } from 'express';

import { protect } from '../middleware/auth.middleware.js';
import {
  nutricionistas,
  aceitarNutri,
  recusarNutri,
  professores,
  desempenho,
  volume,
} from '../controllers/aluno.controller.js';

const router = Router();

router.use(protect);

router.get('/nutricionistas', nutricionistas);
router.post('/nutricionistas/:vinculoId/aceitar', aceitarNutri);
router.delete('/nutricionistas/:vinculoId', recusarNutri);
router.get('/professores', professores);

// Desempenho atlético agregado — alimenta a tab Desempenho do Progresso
router.get('/:alunoId/desempenho', desempenho);
router.get('/desempenho', desempenho); // ALUNO sem param — usa o próprio

// PR #20 — Matriz de Volume Semanal. Mesma ACL (resolveAlunoAccess
// no service). `?weeks=N` (4..52, default 12).
router.get('/:alunoId/volume', volume);
router.get('/volume', volume);

export default router;
