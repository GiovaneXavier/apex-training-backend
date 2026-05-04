import { Router } from 'express';

import { requireAuth } from '../middleware/auth.middleware.js';
import {
  nutricionistas,
  aceitarNutri,
  recusarNutri,
  professores,
} from '../controllers/aluno.controller.js';

const router = Router();

router.use(requireAuth);

router.get('/nutricionistas', nutricionistas);
router.post('/nutricionistas/:vinculoId/aceitar', aceitarNutri);
router.delete('/nutricionistas/:vinculoId', recusarNutri);
router.get('/professores', professores);

export default router;
