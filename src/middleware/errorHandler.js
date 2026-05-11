import { ZodError } from 'zod';

export function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  if (err instanceof ZodError) {
    return res.status(400).json({ error: 'ValidationError', issues: err.issues });
  }

  // HttpError (qualquer status, incluindo 5xx como 502 upstream) entrega
  // a mensagem real ao cliente — mensagens escritas por nós, sem stack leak.
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.name || 'Error', message: err.message });
  }
  // Compat: outros erros com .status (improvável após PR #5) tratados
  // se forem 4xx (mensagem aceita); 5xx vai pro genérico abaixo.
  if (err.status && err.status < 500) {
    return res.status(err.status).json({ error: err.name || 'Error', message: err.message });
  }

  console.error('[unhandled]', err);
  res.status(500).json({ error: 'InternalServerError' });
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.name = 'HttpError';
  }
}
