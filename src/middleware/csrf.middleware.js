import { safeEqual } from '../lib/crypto.js';
import { HttpError } from './errorHandler.js';

// ─────────────────────────────────────────────────────────────────────
// CSRF — encrypted-token pattern (CSRF token embutido no JWT)
//
// Por que NÃO double-submit-cookie:
//   Em produção frontend e API ficam em domínios diferentes (Vercel +
//   Render). Cookie definido por API.onrender.com não é legível pelo JS
//   em app.vercel.app — mesma origem é exigida por document.cookie.
//   Double-submit clássico não funciona cross-site.
//
// Como funciona aqui:
//   1. Login/register: server gera CSRF random, embute no payload JWT
//      ({sub, role, csrf, ...}), retorna o csrf no BODY da resposta.
//   2. Frontend guarda o csrf em memória (não em cookie, não em LS) e
//      manda em todo POST/PUT/PATCH/DELETE como `X-CSRF-Token`.
//   3. requireAuth decodifica o JWT → expõe `req.user.csrf`.
//   4. Aqui comparamos `req.user.csrf === req.headers['x-csrf-token']`
//      em tempo constante.
//
// Pré-requisito: este middleware roda APÓS requireAuth. Para conveniência,
// o helper `protect` (auth.middleware.js) bunda os dois na ordem correta.
//
// Métodos seguros (GET/HEAD/OPTIONS) passam direto — não alteram estado.
// ─────────────────────────────────────────────────────────────────────

const CSRF_HEADER = 'x-csrf-token';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function requireCsrf(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();

  if (!req.user?.csrf) {
    // Token JWT antigo (pré-PR #5) sem campo csrf → forçar relogin.
    return next(new HttpError(401, 'Sessão sem CSRF — refaça o login'));
  }

  const headerToken = req.headers[CSRF_HEADER];
  if (typeof headerToken !== 'string' || headerToken.length === 0) {
    return next(new HttpError(403, 'CSRF token ausente no header X-CSRF-Token'));
  }
  if (!safeEqual(headerToken, req.user.csrf)) {
    return next(new HttpError(403, 'CSRF token inválido'));
  }
  next();
}
