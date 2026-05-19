import { Router } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';

import { protect } from '../middleware/auth.middleware.js';
import {
  subscribe,
  unsubscribe,
  vapidPublicKey,
  sendTest,
} from '../controllers/push.controller.js';

const router = Router();

// GET /push/vapid-public-key — público (a chave É pública).
// Sem auth pra permitir que o client a busque ANTES de logar (warmup do
// SW). Idempotente, cacheável.
router.get('/vapid-public-key', vapidPublicKey);

// Subscribe/unsubscribe protegidos. Idempotência tratada no service —
// repetir POST com mesmo endpoint atualiza, não duplica.
router.post('/subscriptions', protect, subscribe);
router.delete('/subscriptions', protect, unsubscribe);

// /test — gate adicional: rate-limit 5/min/user pra impedir spam mesmo
// em dev. Controller bloqueia em prod por conta.
const testLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => {
    const uid = req.user?.userId;
    return uid ? `push-test|${uid}` : `push-test|ip|${ipKeyGenerator(req, res)}`;
  },
  message: { error: 'TooManyRequests', message: 'Devagar com os testes de push.' },
});
router.post('/test', protect, testLimiter, sendTest);

export default router;
