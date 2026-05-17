import { z } from 'zod';

import { isAllowedAssetUrl } from '../lib/uploadUrl.js';

// PR #18b — schemas do PlanoAlimentar (PDF + metas).

// URL do PDF tem que pertencer ao bucket S3 configurado (PR #13).
const pdfUrlSchema = z
  .string()
  .url()
  .refine(isAllowedAssetUrl, {
    message: 'URL do PDF fora do allowlist (use o uploader oficial).',
  });

const pdfKeyMaxLen = 256; // key S3 com prefixo + uuid + .pdf cabe folgado.

export const planoCreateSchema = z.object({
  alunoId: z.string().min(1),
  pdfUrl: pdfUrlSchema,
  // pdfKey é opcional: o nutri pode estar usando uploader que não
  // retorna a key (ex: import de CDN externa? — bloqueado pelo allowlist
  // acima, mas mantemos opcional pra forward-compat). Quando presente,
  // guardamos pra facilitar replace/delete no S3.
  pdfKey: z.string().min(1).max(pdfKeyMaxLen).optional(),
  // Foco/metas em texto livre. Cap em 2000 chars cobre uns 300-400
  // palavras — espaço pra resumo de objetivos sem virar tela infinita.
  metasText: z.string().max(2000).optional(),
});

export const planoUpdateSchema = planoCreateSchema
  .partial()
  .omit({ alunoId: true });

export const planoListQuery = z.object({
  alunoId: z.string().min(1),
  // Por default só plano ativo. Histórico via `?ativo=any` ou false.
  ativo: z.enum(['true', 'false', 'any']).default('true'),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
