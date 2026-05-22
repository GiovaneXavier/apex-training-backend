import { env } from '../lib/env.js';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../middleware/errorHandler.js';
import { parseBjjBodySchema, AUDIO_MIME_ALLOWLIST } from '../schemas/voice.schemas.js';
import { transcribeAndExtract } from '../services/voice.service.js';

// PR #25 — Diário de Voz com IA.
//
// POST /api/voice/parse-bjj
//   Body multipart:
//     - audio: blob (campo único, ≤ 5MB, mime na allowlist)
//     - treinoId: UUID do treino BJJ alvo
//
// Cadeia de defesa (importa ordem):
//   1. feature flag → 503 se voiceEnabled=false. Não gasta DB nem rede.
//   2. multer já rejeitou tamanho/mime no parsing (ver routes).
//   3. body schema (UUID) → 400 antes de tocar DB.
//   4. ownership: treino existe + é do user → 403/404. Anti billing-drain.
//   5. service: magic bytes → LLM → Zod canônico. Erros propagam.

export async function parseBjj(req, res, next) {
  try {
    if (!env.voiceEnabled) {
      throw new HttpError(503, 'Diário de voz indisponível (feature off)');
    }

    if (!req.file || !req.file.buffer || req.file.size === 0) {
      throw new HttpError(400, 'Áudio obrigatório (campo "audio")');
    }
    if (!AUDIO_MIME_ALLOWLIST.includes(req.file.mimetype)) {
      // Defesa-em-profundidade: multer fileFilter já cobre, mas se algo
      // passar, paramos aqui antes da rede.
      throw new HttpError(415, `Mime não suportado: ${req.file.mimetype}`);
    }

    const { treinoId } = parseBjjBodySchema.parse({ treinoId: req.body?.treinoId });

    // Ownership check ANTES do LLM — evita gasto de crédito por scraper.
    const aluno = await prisma.aluno.findUnique({ where: { userId: req.user.userId } });
    if (!aluno) throw new HttpError(404, 'Perfil de aluno não encontrado');

    const treino = await prisma.treino.findUnique({
      where: { id: treinoId },
      select: { id: true, alunoId: true, detalhes: true },
    });
    if (!treino) throw new HttpError(404, 'Treino não encontrado');
    if (treino.alunoId !== aluno.id) {
      // 403 (não 404) — anti-enumeration usa a mesma política do resto do app.
      throw new HttpError(403, 'Treino de outro aluno');
    }

    const tipo = treino.detalhes?.tipo;
    if (tipo !== 'jiu_jitsu') {
      throw new HttpError(400, `Diário de voz disponível apenas para Jiu-Jitsu (este treino é ${tipo || 'desconhecido'})`);
    }

    const result = await transcribeAndExtract({
      audioBuffer: req.file.buffer,
      mimeType: req.file.mimetype,
      modalidade: 'jiu_jitsu',
    });

    res.json(result);
  } catch (err) {
    next(err);
  }
}
