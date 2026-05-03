import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware.js';

const router = Router();

router.post('/sync', requireAuth, (req, res) => {
  res.status(501).json({ error: 'NotImplemented', sprint: 'S5' });
});

router.get('/callback', (req, res) => {
  res.status(501).json({ error: 'NotImplemented', sprint: 'S5' });
});

export default router;
