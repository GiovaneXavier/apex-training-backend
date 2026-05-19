import { Router } from 'express';
import multer from 'multer';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';

import { protect, requireRole } from '../middleware/auth.middleware.js';
import { HttpError } from '../middleware/errorHandler.js';
import { parseBjj } from '../controllers/voice.controller.js';
import {
  AUDIO_MIME_ALLOWLIST,
  MAX_AUDIO_BYTES,
} from '../schemas/voice.schemas.js';

const router = Router();

// Multer in-memory — áudio NÃO toca disco. Buffer vive durante o request,
// é consumido pelo service (Anthropic), e GC quando o handler retorna.
//
// fileFilter rejeita cedo (antes do parse de bytes) — economiza CPU em
// ataque de upload massa de payload arbitrário disfarçado de audio/mp3.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_AUDIO_BYTES,
    files: 1,
    fields: 5,
  },
  fileFilter: (req, file, cb) => {
    if (!AUDIO_MIME_ALLOWLIST.includes(file.mimetype)) {
      cb(new HttpError(415, `Mime não suportado: ${file.mimetype}`));
      return;
    }
    cb(null, true);
  },
});

// Rate limit por user (não IP) — em mobile usuários compartilham IP NAT
// e queremos travar abuso individual sem afetar outros usuários da mesma
// rede. Key = userId quando disponível, fallback IP pra pré-auth (que
// não deve acontecer porque rota é protected).
//
// 20 / 24h é generoso pra uso real (1 BJJ/dia x algumas tentativas),
// agressivo pra scraper. Janela rolling de 24h.
const voiceLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => {
    const uid = req.user?.userId;
    if (uid) return `voice|${uid}`;
    return `voice|ip|${ipKeyGenerator(req, res)}`;
  },
  message: {
    error: 'TooManyRequests',
    message: 'Limite diário de diário de voz atingido (20/dia). Tente amanhã.',
  },
});

// Adapter: multer chama next(err) — precisa entrar no errorHandler.
// Se for HttpError, deixa passar; se for MulterError (e.g., LIMIT_FILE_SIZE),
// converte para HttpError 413/400.
function multerErrorAdapter(err, req, res, next) {
  if (!err) return next();
  if (err instanceof HttpError) return next(err);
  if (err.name === 'MulterError') {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return next(new HttpError(413, 'Áudio acima do limite (máx 5MB)'));
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      return next(new HttpError(400, 'Campo de arquivo inesperado (use "audio")'));
    }
    return next(new HttpError(400, `Erro no upload: ${err.message}`));
  }
  next(err);
}

router.post(
  '/parse-bjj',
  protect,
  requireRole('ALUNO'),
  voiceLimiter,
  (req, res, next) => upload.single('audio')(req, res, (err) => multerErrorAdapter(err, req, res, next)),
  parseBjj,
);

export default router;
