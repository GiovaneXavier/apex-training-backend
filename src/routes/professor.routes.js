import { Router } from 'express';

import { protect } from '../middleware/auth.middleware.js';
import {
  alunos,
  vincular,
  removerVinculo,
  alunoDetalhe,
  dashboard,
  calendario,
  alertas,
} from '../controllers/professor.controller.js';

const router = Router();

router.use(protect);

router.get('/dashboard', dashboard);
router.get('/alertas', alertas);
router.get('/calendario', calendario);
router.get('/alunos', alunos);
router.post('/vincular', vincular);
router.delete('/vinculo/:vinculoId', removerVinculo);
router.get('/aluno/:alunoId', alunoDetalhe);

export default router;
