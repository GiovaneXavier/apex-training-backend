import { ZodError } from 'zod';

export function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  if (err instanceof ZodError) {
    return res.status(400).json({ error: 'ValidationError', issues: err.issues });
  }

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
