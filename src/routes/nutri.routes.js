import { Router } from 'express';

import { requireAuth } from '../middleware/auth.middleware.js';
import { alunos, solicitar, removerVinculo, alunoDetalhe } from '../controllers/nutri.controller.js';

const router = Router();

router.use(requireAuth);

router.get('/alunos', alunos);
router.post('/solicitar', solicitar);
router.delete('/vinculo/:vinculoId', removerVinculo);
router.get('/aluno/:alunoId', alunoDetalhe);

export default router;
