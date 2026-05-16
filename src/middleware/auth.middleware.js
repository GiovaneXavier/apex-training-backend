import jwt from 'jsonwebtoken';
import { env } from '../lib/env.js';
import { HttpError } from './errorHandler.js';
import { requireCsrf } from './csrf.middleware.js';

// Nome do cookie HttpOnly que carrega o JWT.
// Não confundir com `apex.user` (frontend, cache leve de perfil — não-sensível).
export const AUTH_COOKIE_NAME = 'apex.token';

// requireAuth — lê o JWT do cookie HttpOnly em primeiro lugar; cai pro
// header `Authorization: Bearer` como fallback. O Bearer fallback existe
// só pra grace period da migração e pra testes Postman/curl. Quando
// estabilizar, derrubar.
//
// Mensagens distinguem expirado vs inválido — frontend pode decidir
// se mostra "sessão expirou" vs "deslogou".
export function requireAuth(req, res, next) {
  let token = req.cookies?.[AUTH_COOKIE_NAME];
  if (!token) {
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) token = header.slice(7);
  }
  if (!token) return next(new HttpError(401, 'Token ausente'));

  try {
    const payload = jwt.verify(token, env.JWT_SECRET);
    req.user = payload;
    return next();
  } catch (err) {
    if (err && err.name === 'TokenExpiredError') {
      return next(new HttpError(401, 'Token expirado'));
    }
    return next(new HttpError(401, 'Token inválido'));
  }
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return next(new HttpError(401, 'Não autenticado'));
    if (!roles.includes(req.user.role)) return next(new HttpError(403, 'Acesso negado'));
    next();
  };
}

// protect = requireAuth → requireCsrf em sequência.
// GET/HEAD/OPTIONS passam pelo CSRF sem validar (early-return interno).
// Substitui requireAuth em todas as rotas autenticadas a partir do PR #5.
export function protect(req, res, next) {
  requireAuth(req, res, (err) => {
    if (err) return next(err);
    requireCsrf(req, res, next);
  });
}
