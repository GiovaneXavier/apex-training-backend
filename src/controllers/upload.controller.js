import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { HttpError } from '../middleware/errorHandler.js';

// PR #18b — allowlist agora é POR KIND. Cada categoria tem MIME e cap
// próprios: imagens são limitadas a 8MB porque JPEG/WebP modernos cabem
// nisso. PDFs de plano alimentar geram-se com 1-5MB tipicamente
// (algumas páginas com imagens) mas podem chegar a 15MB em planos
// complexos — cap em 15MB. Acoplado ao guard SSE assinado (PR #13),
// não há vetor pra subir um arquivo de 10GB mesmo que o cliente minta.
const KIND_RULES = {
  evolucao: {
    mimes: ['image/jpeg', 'image/png', 'image/webp', 'image/heic'],
    maxBytes: 8 * 1024 * 1024,
    label: 'imagem',
  },
  avatar: {
    mimes: ['image/jpeg', 'image/png', 'image/webp', 'image/heic'],
    maxBytes: 8 * 1024 * 1024,
    label: 'imagem',
  },
  'plano-alimentar': {
    mimes: ['application/pdf'],
    maxBytes: 15 * 1024 * 1024,
    label: 'PDF',
  },
};

const MIME_TO_EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'application/pdf': 'pdf',
};

const presignQuerySchema = z
  .object({
    contentType: z.string(),
    contentLength: z.coerce.number().int().positive(),
    kind: z.enum(['evolucao', 'avatar', 'plano-alimentar']).default('evolucao'),
  })
  .superRefine((v, ctx) => {
    const rule = KIND_RULES[v.kind];
    if (!rule) return; // nunca acontece, o enum acima trava
    if (!rule.mimes.includes(v.contentType)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['contentType'],
        message: `Tipo de ${rule.label} não suportado para "${v.kind}" (esperado: ${rule.mimes.join(', ')}).`,
      });
    }
    if (v.contentLength > rule.maxBytes) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['contentLength'],
        message: `Arquivo excede o limite de ${rule.maxBytes} bytes para "${v.kind}".`,
      });
    }
  });

let cachedClient = null;
function getS3Client() {
  if (cachedClient) return cachedClient;

  const region = process.env.AWS_REGION;
  const bucket = process.env.S3_BUCKET;
  if (!region || !bucket) {
    throw new HttpError(500, 'Storage S3 não configurado (AWS_REGION/S3_BUCKET).');
  }

  // Em produção use IAM role (EC2/ECS/Lambda) — credenciais explícitas só
  // pra dev/CI. O SDK descobre via cadeia padrão se não passarmos nada.
  cachedClient = new S3Client({
    region,
    ...(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
      ? {
          credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
          },
        }
      : {}),
  });
  return cachedClient;
}

function buildPublicUrl(bucket, region, key) {
  // Se houver CDN (CloudFront), preferimos ela — TLS terminado mais perto do
  // usuário e custo de egress menor. Fallback pro endpoint S3 padrão.
  const cdn = process.env.CDN_BASE_URL?.replace(/\/$/, '');
  if (cdn) return `${cdn}/${key}`;
  return `https://${bucket}.s3.${region}.amazonaws.com/${key}`;
}

export async function presignUpload(req, res, next) {
  try {
    const { contentType, contentLength, kind } = presignQuerySchema.parse(req.query);

    const userId = req.user?.sub;
    if (!userId) throw new HttpError(401, 'Não autenticado');

    const bucket = process.env.S3_BUCKET;
    const region = process.env.AWS_REGION;
    const ext = MIME_TO_EXT[contentType];

    // Key estruturada: kind/userId/uuid.ext.
    // - userId no path facilita policy IAM por usuário no futuro
    // - UUID evita colisão e ofusca enumeração
    const key = `${kind}/${userId}/${randomUUID()}.${ext}`;

    // PR #13 (audit 2.16) — defesa em profundidade nos uploads.
    //
    // O PUT presigned URL embute CADA campo abaixo na assinatura V4.
    // Cliente que tentar enviar valor diferente recebe SignatureDoesNotMatch
    // do S3 — equivalente prático aos `content-length-range` e
    // `starts-with: content-type` das POST policies, mas sem trocar o
    // verbo HTTP e quebrar o cliente.
    //
    //   - ContentType   → trava o MIME (não pode subir .iso disfarçado).
    //   - ContentLength → trava o tamanho EXATO (não dá pra dizer 1KB e
    //                     enviar 10GB; o S3 corta).
    //   - SSE AES256    → S3 só aceita o PUT se a regra de criptografia
    //                     for honrada. Combinada com a bucket policy
    //                     `Deny s3:PutObject if not aws:KmsKeyId`, blinda
    //                     dados em repouso.
    //   - Metadata      → audit trail no objeto pro housekeeping futuro.
    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentType: contentType,
      ContentLength: contentLength,
      ServerSideEncryption: 'AES256',
      Metadata: {
        userId: String(userId),
        kind,
      },
    });

    // 5 minutos é folgado pra qualquer rede móvel decente sem deixar
    // a URL viva tempo demais caso vaze em logs.
    const uploadUrl = await getSignedUrl(getS3Client(), command, { expiresIn: 300 });
    const publicUrl = buildPublicUrl(bucket, region, key);

    res.json({
      uploadUrl,
      publicUrl,
      key,
      // Headers obrigatórios que o client DEVE enviar no PUT — se divergir,
      // a assinatura é invalidada pelo S3.
      requiredHeaders: {
        'Content-Type': contentType,
      },
      expiresIn: 300,
    });
  } catch (err) {
    next(err);
  }
}
