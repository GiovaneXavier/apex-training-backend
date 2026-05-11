import { z } from 'zod';

// Validação central de variáveis de ambiente.
// Fail-fast no boot: se faltar algo crítico em produção, o processo termina
// antes de aceitar requisições. Em dev, emite warning e segue com defaults
// quando seguro.
//
// Uso:
//   import { env } from './lib/env.js';
//   const port = env.PORT;
//
// IMPORTANTE: este módulo deve ser importado APÓS `import 'dotenv/config'`
// no entrypoint. Em testes, popule process.env antes do import.

const PLACEHOLDER_SECRETS = new Set([
  '', 'change-me', 'change-me-in-production', 'secret', 'changeme',
]);

// Helpers de refine reutilizáveis ─────────────────────────────────

// JWT_SECRET: rejeita placeholders conhecidos e exige >=32 chars em prod.
const jwtSecretSchema = z.string().superRefine((val, ctx) => {
  if (PLACEHOLDER_SECRETS.has(val)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'JWT_SECRET é placeholder. Gere com: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64\'))"',
    });
    return;
  }
  if (process.env.NODE_ENV === 'production' && val.length < 32) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `JWT_SECRET muito fraco em produção (tem ${val.length} chars, exige >=32).`,
    });
  }
});

// STRAVA_TOKEN_KEY: chave AES-256. Exige 32 bytes decodificados de base64.
// Em dev pode ficar vazia (criptografia desligada — feature flag implícito).
const strava256BitKey = z.string().superRefine((val, ctx) => {
  if (!val) return; // opcional em dev
  let buf;
  try {
    buf = Buffer.from(val, 'base64');
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'STRAVA_TOKEN_KEY deve ser base64 válido.' });
    return;
  }
  if (buf.length !== 32) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `STRAVA_TOKEN_KEY deve decodar para 32 bytes (AES-256). Atual: ${buf.length} bytes. Gere com: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
    });
  }
});

// CORS_ORIGIN: aceita '*' em dev, lista CSV de URLs em prod.
const corsOriginSchema = z.string().optional().default('').superRefine((val, ctx) => {
  if (process.env.NODE_ENV === 'production' && val.trim() === '*') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'CORS_ORIGIN="*" é proibido em produção (incompatível com credentials: true).',
    });
  }
});

// Schema completo ────────────────────────────────────────────────

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().max(65535).default(3000),

  // CORS
  CORS_ORIGIN: corsOriginSchema,
  FRONTEND_URL: z.string().url().optional().or(z.literal('')),

  // Database
  DATABASE_URL: z.string().min(1, 'DATABASE_URL é obrigatória'),
  DIRECT_URL: z.string().min(1, 'DIRECT_URL é obrigatória').optional(),

  // Auth
  JWT_SECRET: jwtSecretSchema,
  JWT_EXPIRES_IN: z.string().default('7d'),

  // Strava — opcional como feature toggle (sem chaves = endpoints retornam 500 com msg clara)
  STRAVA_CLIENT_ID: z.string().optional().or(z.literal('')),
  STRAVA_CLIENT_SECRET: z.string().optional().or(z.literal('')),
  STRAVA_REDIRECT_URI: z.string().url().optional().or(z.literal('')),
  // AES-256-GCM key para criptografar tokens Strava no banco (sprint 1, PR #3).
  STRAVA_TOKEN_KEY: strava256BitKey.optional().or(z.literal('')),

  // S3 — opcional
  AWS_REGION: z.string().optional().or(z.literal('')),
  S3_BUCKET: z.string().optional().or(z.literal('')),
  AWS_ACCESS_KEY_ID: z.string().optional().or(z.literal('')),
  AWS_SECRET_ACCESS_KEY: z.string().optional().or(z.literal('')),
  CDN_BASE_URL: z.string().url().optional().or(z.literal('')),
});

// Cross-field rules: features que exigem grupo inteiro de vars ──

function crossValidate(parsed) {
  const errors = [];
  const warnings = [];
  const isProd = parsed.NODE_ENV === 'production';

  // Em prod, FRONTEND_URL é fonte da verdade pra CORS + cookies SameSite.
  if (isProd && !parsed.FRONTEND_URL) {
    errors.push('FRONTEND_URL é obrigatória em produção (cookies cross-site exigem origem explícita).');
  }

  // Em prod, STRAVA_TOKEN_KEY é obrigatória — não vamos persistir token plain.
  if (isProd && !parsed.STRAVA_TOKEN_KEY) {
    errors.push('STRAVA_TOKEN_KEY obrigatória em produção (AES-256 para tokens Strava).');
  } else if (!isProd && !parsed.STRAVA_TOKEN_KEY) {
    warnings.push('STRAVA_TOKEN_KEY ausente em dev. Tokens Strava NÃO serão criptografados.');
  }

  // Strava: feature toggle pelos secrets. Se um setado, o outro também.
  // REDIRECT_URI pode ficar default no .env.example sem ativar feature.
  if (Boolean(parsed.STRAVA_CLIENT_ID) !== Boolean(parsed.STRAVA_CLIENT_SECRET)) {
    errors.push('Configuração Strava parcial. Setar STRAVA_CLIENT_ID e STRAVA_CLIENT_SECRET juntos.');
  }
  if (parsed.STRAVA_CLIENT_ID && parsed.STRAVA_CLIENT_SECRET && !parsed.STRAVA_REDIRECT_URI) {
    errors.push('STRAVA_REDIRECT_URI obrigatório quando Strava ativa.');
  }

  // S3: se algum, exigir region+bucket pelo menos (credenciais podem vir de IAM role).
  if ((parsed.AWS_ACCESS_KEY_ID || parsed.AWS_SECRET_ACCESS_KEY || parsed.S3_BUCKET) &&
      !(parsed.AWS_REGION && parsed.S3_BUCKET)) {
    errors.push('Configuração S3 incompleta. Setar AWS_REGION e S3_BUCKET no mínimo.');
  }
  if (parsed.AWS_ACCESS_KEY_ID && !parsed.AWS_SECRET_ACCESS_KEY) {
    errors.push('AWS_ACCESS_KEY_ID setado sem AWS_SECRET_ACCESS_KEY.');
  }
  if (parsed.AWS_SECRET_ACCESS_KEY && !parsed.AWS_ACCESS_KEY_ID) {
    errors.push('AWS_SECRET_ACCESS_KEY setado sem AWS_ACCESS_KEY_ID.');
  }

  return { errors, warnings };
}

// Parse + report ────────────────────────────────────────────────

function loadEnv() {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error('[env] Falha de validação:');
    for (const issue of result.error.issues) {
      const path = issue.path.join('.') || '(raiz)';
      console.error(`  - ${path}: ${issue.message}`);
    }
    process.exit(1);
  }

  const { errors, warnings } = crossValidate(result.data);
  for (const w of warnings) console.warn(`[env] aviso: ${w}`);
  if (errors.length > 0) {
    console.error('[env] Falha cross-field:');
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }

  // Derivados úteis ─ origens CORS deduplicadas e normalizadas.
  const csvOrigins = (result.data.CORS_ORIGIN || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const wildcard = csvOrigins.includes('*');
  const corsOrigins = wildcard
    ? '*'
    : Array.from(new Set([...csvOrigins, result.data.FRONTEND_URL].filter(Boolean)));

  return {
    ...result.data,
    // Helpers derivados — preferir esses no app code.
    isProd: result.data.NODE_ENV === 'production',
    isDev: result.data.NODE_ENV === 'development',
    isTest: result.data.NODE_ENV === 'test',
    corsOrigins,
    stravaEnabled: Boolean(
      result.data.STRAVA_CLIENT_ID && result.data.STRAVA_CLIENT_SECRET,
    ),
    s3Enabled: Boolean(result.data.AWS_REGION && result.data.S3_BUCKET),
  };
}

export const env = loadEnv();
