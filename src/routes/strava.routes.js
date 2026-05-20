import { Router } from 'express';

import { protect } from '../middleware/auth.middleware.js';
import {
  conectar,
  desconectar,
  obterStatus,
  sincronizar,
  atividades,
  webhookVerify,
  webhookEvent,
} from '../controllers/strava.controller.js';

const router = Router();

// PR #41a — Webhook endpoints PÚBLICOS (sem JWT).
// Registrados ANTES do router.use(protect) — Strava não tem cookie/token
// nosso. Defesa: constant-time compare do hub.verify_token em GET; service
// valida shape + lookup do owner em POST.
router.get('/webhook', webhookVerify);
router.post('/webhook', webhookEvent);

// Tudo abaixo exige autenticação do nosso app.
router.use(protect);

router.get('/status', obterStatus);
router.post('/connect', conectar);
router.post('/disconnect', desconectar);
router.post('/sync', sincronizar);
router.get('/atividades/:alunoId', atividades);

export default router;
