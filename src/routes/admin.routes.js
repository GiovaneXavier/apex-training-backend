import { Router } from 'express';

import { protect } from '../middleware/auth.middleware.js';
import {
  metricasGlobais,
  listUsuarios,
  aprovarUsuarioCtrl,
  atualizarStatusCtrl,
  detalheUsuarioCtrl,
} from '../controllers/admin.controller.js';

const router = Router();

router.use(protect);

// PR #42 — Cockpit Fase 1 (métricas globais).
router.get('/metrics', metricasGlobais);

// PR #43 — Bloco B: Gerenciamento de Usuários.
// Rotas estáticas antes de paramétricas (mesmo padrão de treinos.routes).
router.get('/users', listUsuarios);
router.get('/users/:id', detalheUsuarioCtrl);
router.patch('/users/:id/aprovar', aprovarUsuarioCtrl);
router.patch('/users/:id/status', atualizarStatusCtrl);

export default router;
