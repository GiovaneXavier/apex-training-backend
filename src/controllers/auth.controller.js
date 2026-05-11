import { registerSchema, loginSchema } from '../schemas/auth.schemas.js';
import { registerUser, loginUser, getMe } from '../services/auth.service.js';
import { authCookieOptions, clearAuthCookieOptions } from '../lib/cookies.js';
import { AUTH_COOKIE_NAME } from '../middleware/auth.middleware.js';

function setAuthCookie(res, token) {
  res.cookie(AUTH_COOKIE_NAME, token, authCookieOptions());
}

export async function register(req, res, next) {
  try {
    const data = registerSchema.parse(req.body);
    const result = await registerUser(data);

    // Profissional pendente: 202 Accepted, sem cookie nem token.
    if (result.pending) {
      return res.status(202).json({
        pending: true,
        message: result.message,
      });
    }

    setAuthCookie(res, result.token);
    // CSRF vai no body — frontend guarda em memória.
    res.status(201).json({ user: result.user, csrf: result.csrf });
  } catch (err) {
    next(err);
  }
}

export async function login(req, res, next) {
  try {
    const data = loginSchema.parse(req.body);
    const result = await loginUser(data);
    setAuthCookie(res, result.token);
    res.json({ user: result.user, csrf: result.csrf });
  } catch (err) {
    next(err);
  }
}

export async function logout(req, res) {
  res.clearCookie(AUTH_COOKIE_NAME, clearAuthCookieOptions());
  res.json({ ok: true });
}

export async function me(req, res, next) {
  try {
    // Passa o csrf decodificado do JWT — getMe ecoa no body pra frontend
    // reidratar após reload (memory state perde no F5).
    const result = await getMe(req.user.userId, req.user.csrf);
    res.json(result);
  } catch (err) {
    next(err);
  }
}
