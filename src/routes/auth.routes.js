import { Router } from 'express';

const router = Router();

router.post('/register', (req, res) => {
  res.status(501).json({ error: 'NotImplemented', sprint: 'S1' });
});

router.post('/login', (req, res) => {
  res.status(501).json({ error: 'NotImplemented', sprint: 'S1' });
});

export default router;
