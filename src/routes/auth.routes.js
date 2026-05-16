import { Router } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';

import { register, login, logout, me } from '../controllers/auth.controller.js';
import { protect } from '../middleware/auth.middleware.js';

const router = Router();

// Rate limits diferenciados por superfície:
//
//   login    — 10 tentativas / 15min por (IP, email).
//              Email lowercased no keygen pra não permitir burlar variando case.
//
//   register — 5 contas / 1h por IP.
//              Combate criação em massa antes do gate de email-verification.
//
//   /me      — sem limite explícito (polled pelo AuthContext na hidratação).
//              requireAuth já bloqueia anon; abuso aqui = DB lookup indexado.
//
//   /logout  — sem limite. Custo zero, libera o cookie só. Spam é benigno.

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => {
    const email = String(req.body?.email ?? '').toLowerCase().trim();
    // ipKeyGenerator normaliza IPv6 pra prefixo /64 — evita atacante
    // rotacionar endereços dentro do mesmo bloco e burlar o limite.
    return `${ipKeyGenerator(req, res)}|${email}`;
  },
  message: {
    error: 'TooManyRequests',
    message: 'Muitas tentativas de login. Tente novamente em alguns minutos.',
  },
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => ipKeyGenerator(req, res),
  message: {
    error: 'TooManyRequests',
    message: 'Muitas tentativas de cadastro. Aguarde uma hora.',
  },
});

router.post('/register', registerLimiter, register);
router.post('/login', loginLimiter, login);
// /me e /logout exigem sessão. CSRF roda em /logout (POST) via `protect`.
router.get('/me', protect, me);
router.post('/logout', protect, logout);

export default router;
