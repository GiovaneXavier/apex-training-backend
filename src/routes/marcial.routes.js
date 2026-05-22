import { Router } from 'express';

import { protect } from '../middleware/auth.middleware.js';
import {
  faixaAtual, jornada, list, create, remove,
} from '../controllers/marcial.controller.js';

const router = Router();

router.use(protect);

// Ordem importa: rotas paramétricas com sub-path antes da :id.
router.get('/aluno/:alunoId/atual', faixaAtual);
router.get('/aluno/:alunoId/jornada', jornada);
router.get('/atual', faixaAtual);     // ALUNO usa o próprio
router.get('/jornada', jornada);      // idem
router.get('/', list);
router.post('/', create);
router.delete('/:id', remove);

export default router;
