import { Router } from 'express';

import { protect } from '../middleware/auth.middleware.js';
import {
  metricasGlobais,
  listUsuarios,
  aprovarUsuarioCtrl,
  atualizarStatusCtrl,
  detalheUsuarioCtrl,
  substituirVinculoCtrl,
  removerVinculoCtrl,
  listProfessoresAtivosCtrl,
  listAuditLogsCtrl,
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

// PR #44 — Bloco C: Overrides de vínculo.
// Rotas estáticas (/professores/ativos) antes de paramétricas
// (/alunos/:alunoId/...) seguindo padrão do projeto.
router.get('/professores/ativos', listProfessoresAtivosCtrl);
router.put('/alunos/:alunoId/vinculo-professor', substituirVinculoCtrl);
router.delete('/alunos/:alunoId/vinculo-professor', removerVinculoCtrl);

// PR #45 — Bloco D: Audit log viewer (read-only).
router.get('/audit', listAuditLogsCtrl);

export default router;
