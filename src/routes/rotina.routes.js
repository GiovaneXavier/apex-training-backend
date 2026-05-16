import { Router } from 'express';
import { protect, requireRole } from '../middleware/auth.middleware.js';
import {
  list, getOne, create, update, remove,
  doDia, iniciar, reagendar,
} from '../controllers/rotina.controller.js';

const router = Router();

// Toda rota deste módulo exige autenticação. ACL fina (vínculo + aceitação
// do nutri) acontece no service via resolveAlunoAccess — defesa em camadas.
router.use(protect);

// Aluno consulta rotinas do dia + dispara instância
// `doDia` agora exige user no service; antes era pública para qualquer autenticado.
router.get('/aluno/:alunoId/dia', doDia);
router.post('/:id/iniciar', requireRole('ALUNO'), iniciar);

// Aluno reagenda treino — endpoint sob /api/rotinas para manter o módulo contido
router.patch('/treinos/:id/reagendar', requireRole('ALUNO'), reagendar);

// Listar / get — qualquer autenticado, MAS service exige alunoId + vínculo.
// Sem alunoId no query → 400 (ver rotinaListQuery).
router.get('/', list);
router.get('/:id', getOne);

// Mutação — apenas PROFESSOR (gate de role) + vínculo (gate de ACL no service).
router.post('/', requireRole('PROFESSOR'), create);
router.put('/:id', requireRole('PROFESSOR'), update);
router.delete('/:id', requireRole('PROFESSOR'), remove);

export default router;
