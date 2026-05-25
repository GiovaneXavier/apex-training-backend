import { registerSchema, loginSchema } from '../schemas/auth.schemas.js';
import { registerUser, loginUser, getMe } from '../services/auth.service.js';
import { authCookieOptions, clearAuthCookieOptions } from '../lib/cookies.js';
import { AUTH_COOKIE_NAME } from '../middleware/auth.middleware.js';
import { logAudit, AUDIT_ACTIONS } from '../lib/auditLog.js';

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
  let parsedEmail;
  try {
    const data = loginSchema.parse(req.body);
    parsedEmail = data.email;
    const result = await loginUser(data);
    setAuthCookie(res, result.token);

    // PR #45 — audit de login bem-sucedido. entityId é o User.id do
    // próprio ator (auto-ação). Payload guarda só email pra correlação
    // sem dados sensíveis.
    logAudit({
      action: AUDIT_ACTIONS.AUTH_LOGIN,
      entityType: 'User',
      entityId: result.user.id,
      payload: { email: result.user.email, role: result.user.role },
      atorUserId: result.user.id,
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });

    res.json({ user: result.user, csrf: result.csrf });
  } catch (err) {
    // PR #45 — audit de login falhou. atorUserId precisa de um user
    // real (FK Restrict) — usamos um sentinel ou pulamos. Decisão:
    // PULAR quando não conseguimos resolver o atorUserId. Log de
    // falha de auth ainda sai via Sentry/morgan; audit só captura
    // tentativas onde temos certeza do alvo.
    //
    // Alternativa futura: criar user "system" no seed pra ser dono
    // de logs anônimos. Por ora, mantemos o log estatístico fora
    // do AuditLog (Sentry breadcrumb cobre).
    if (parsedEmail) {
      console.warn('[auth] login falhou pra', parsedEmail, '→', err?.message || 'erro');
    }
    next(err);
  }
}

export async function logout(req, res) {
  res.clearCookie(AUTH_COOKIE_NAME, clearAuthCookieOptions());

  // PR #45 — audit de logout. req.user só existe se o middleware protect
  // rodou antes — logout deve estar protegido, mas defensivamente
  // checamos pra evitar crash em rota mal-configurada.
  if (req.user?.userId) {
    logAudit({
      action: AUDIT_ACTIONS.AUTH_LOGOUT,
      entityType: 'User',
      entityId: req.user.userId,
      atorUserId: req.user.userId,
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });
  }

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
