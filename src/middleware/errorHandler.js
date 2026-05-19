import { ZodError } from 'zod';

import { captureUnexpectedError } from '../lib/sentry.js';

export function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  if (err instanceof ZodError) {
    return res.status(400).json({ error: 'ValidationError', issues: err.issues });
  }

  // HttpError (qualquer status, incluindo 5xx como 502 upstream) entrega
  // a mensagem real ao cliente — mensagens escritas por nós, sem stack leak.
  if (err instanceof HttpError) {
    // PR #34 — reportar 5xx mesmo se for HttpError (504, 502 upstream).
    // 4xx HttpError fica fora — rejeição esperada do app.
    if (err.status >= 500) {
      captureUnexpectedError(err, {
        path: req?.path, method: req?.method, status: err.status,
      });
    }
    return res.status(err.status).json({ error: err.name || 'Error', message: err.message });
  }
  // Compat: outros erros com .status (improvável após PR #5) tratados
  // se forem 4xx (mensagem aceita); 5xx vai pro genérico abaixo.
  if (err.status && err.status < 500) {
    return res.status(err.status).json({ error: err.name || 'Error', message: err.message });
  }

  // PR #34 — 5xx genéricos (não-HttpError) sempre capturados. Inclui
  // bugs reais: TypeError, ReferenceError, throws não-tratados.
  console.error('[unhandled]', err);
  captureUnexpectedError(err, {
    path: req?.path, method: req?.method, status: 500,
  });
  res.status(500).json({ error: 'InternalServerError' });
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.name = 'HttpError';
  }
}
