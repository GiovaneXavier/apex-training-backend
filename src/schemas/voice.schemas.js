import { z } from 'zod';

// PR #25 — Diário de Voz com IA.
//
// Request schema do endpoint POST /api/voice/parse-bjj. O áudio em si vem
// via multer (multipart) — aqui só validamos campos textuais do body.
//
// Caps:
//   treinoId — UUID estrito; rota verifica ownership antes de chamar LLM
//              (defesa-em-profundidade contra billing-drain).

export const parseBjjBodySchema = z
  .object({
    treinoId: z.string().uuid('treinoId deve ser UUID válido'),
  })
  .strict();

// Allowlist MIME generosa — Safari iOS encapsula áudio em video/mp4 em
// versões antigas e cuspe audio/mp4 ou audio/aac nas recentes. Allowlist
// estrita ('audio/webm' only) quebraria gravação em iPhone.
// Magic bytes são checados depois no service como segunda camada.
export const AUDIO_MIME_ALLOWLIST = Object.freeze([
  'audio/webm',
  'audio/ogg',
  'audio/mp4',
  'audio/aac',
  'audio/mpeg',
  'video/mp4',
]);

export const MAX_AUDIO_BYTES = 5 * 1024 * 1024; // 5 MB
export const MAX_AUDIO_DURATION_HINT_SEG = 120; // UI grava até 90s; 120 cap server-side defensivo

// Schema do payload que o LLM devolve via tool_use. A diferença pro
// realizadoJiuJitsuSchema é que aqui aceitamos os mesmos campos mas com
// `confidence` adicional. A validação final usa o schema canônico do
// execucao — este é só guia pro tool input_schema da Anthropic.
export const voiceExtractSchema = z
  .object({
    matTimeSegundos: z.number().int().nonnegative().max(14_400).optional(),
    roundsCompletos: z.number().int().nonnegative().max(50).optional(),
    finalizacoesFeitas: z.number().int().nonnegative().max(50).optional(),
    finalizacoesSofridas: z.number().int().nonnegative().max(50).optional(),
    readinessRating: z.number().int().min(1).max(10).optional(),
    observacao: z.string().max(500).optional(),
    confidence: z.number().min(0).max(1).optional(),
  })
  .strict();
