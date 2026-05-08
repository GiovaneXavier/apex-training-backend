import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware.js';
import { presignUpload } from '../controllers/upload.controller.js';

const router = Router();

// GET /api/upload/presigned-url?contentType=image/jpeg&contentLength=12345&kind=evolucao
// Resposta: { uploadUrl, publicUrl, key, requiredHeaders, expiresIn }
router.get('/presigned-url', requireAuth, presignUpload);

export default router;
