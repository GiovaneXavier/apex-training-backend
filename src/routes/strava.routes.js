import { Router } from 'express';

import { protect } from '../middleware/auth.middleware.js';
import {
  conectar,
  desconectar,
  obterStatus,
  sincronizar,
  atividades,
} from '../controllers/strava.controller.js';

const router = Router();

router.use(protect);

router.get('/status', obterStatus);
router.post('/connect', conectar);
router.post('/disconnect', desconectar);
router.post('/sync', sincronizar);
router.get('/atividades/:alunoId', atividades);

export default router;
