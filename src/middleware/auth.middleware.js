import jwt from 'jsonwebtoken';
import { HttpError } from './errorHandler.js';

export function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return next(new HttpError(401, 'Token ausente'));
  }
  try {
    const token = header.slice(7);
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload;
    next();
  } catch {
    next(new HttpError(401, 'Token inválido'));
  }
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return next(new HttpError(401, 'Não autenticado'));
    if (!roles.includes(req.user.role)) return next(new HttpError(403, 'Acesso negado'));
    next();
  };
}
