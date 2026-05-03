import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware.js';

const router = Router();

router.get('/:alunoId', requireAuth, (req, res) => {
  res.status(501).json({ error: 'NotImplemented', sprint: 'S6' });
});

export default router;
