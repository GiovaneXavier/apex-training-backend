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
  listarSugestoes,
  aceitarSugestaoCtrl,
  rejeitarSugestaoCtrl,
  desfazerMatchCtrl,
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

// PR #41b — Sugestões Tier 2 + undo Tier 1. Todas exigem JWT do aluno.
router.get('/sugestoes', listarSugestoes);
router.post('/sugestoes/:id/aceitar', aceitarSugestaoCtrl);
router.post('/sugestoes/:id/rejeitar', rejeitarSugestaoCtrl);
router.post('/treinos/:treinoId/desfazer-strava', desfazerMatchCtrl);

export default router;
