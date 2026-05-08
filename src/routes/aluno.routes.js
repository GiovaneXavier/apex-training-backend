import { Router } from 'express';

import { requireAuth } from '../middleware/auth.middleware.js';
import {
  nutricionistas,
  aceitarNutri,
  recusarNutri,
  professores,
  desempenho,
} from '../controllers/aluno.controller.js';

const router = Router();

router.use(requireAuth);

router.get('/nutricionistas', nutricionistas);
router.post('/nutricionistas/:vinculoId/aceitar', aceitarNutri);
router.delete('/nutricionistas/:vinculoId', recusarNutri);
router.get('/professores', professores);

// Desempenho atlético agregado — alimenta a tab Desempenho do Progresso
router.get('/:alunoId/desempenho', desempenho);
router.get('/desempenho', desempenho); // ALUNO sem param — usa o próprio

export default router;
