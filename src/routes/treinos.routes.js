import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware.js';

const router = Router();

router.get('/:alunoId', requireAuth, (req, res) => {
  res.status(501).json({ error: 'NotImplemented', sprint: 'S2' });
});

router.post('/:id/salvar', requireAuth, (req, res) => {
  res.status(501).json({ error: 'NotImplemented', sprint: 'S3' });
});

router.post('/prescrever', requireAuth, (req, res) => {
  res.status(501).json({ error: 'NotImplemented', sprint: 'S4' });
});

export default router;
