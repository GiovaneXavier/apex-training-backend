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
  // PR #41a (Sprint 15) — Webhook do Strava.
  // VERIFY_TOKEN: string aleatória validada no challenge GET inicial pra
  // provar pro Strava que somos donos do endpoint. Strava NÃO envia este
  // token nos POST events — só no setup da subscription.
  STRAVA_VERIFY_TOKEN: z.string().min(16, 'STRAVA_VERIFY_TOKEN deve ter >= 16 chars').optional().or(z.literal('')),
  // CALLBACK_URL: URL pública do endpoint /api/strava/webhook.
  // Dev: ngrok/cloudflare tunnel. Prod: domínio do Render. Strava só
  // aceita HTTPS em prod (HTTP libera só pra localhost test).
  STRAVA_WEBHOOK_CALLBACK_URL: z.string().url().optional().or(z.literal('')),

  // S3 — opcional
  AWS_REGION: z.string().optional().or(z.literal('')),
  S3_BUCKET: z.string().optional().or(z.literal('')),
  AWS_ACCESS_KEY_ID: z.string().optional().or(z.literal('')),
  AWS_SECRET_ACCESS_KEY: z.string().optional().or(z.literal('')),
  CDN_BASE_URL: z.string().url().optional().or(z.literal('')),

  // Web Push (PR #26) — feature toggle.
  // VAPID keys são forever-coupled com TODAS as subscriptions ativas.
  // Rotação = invalidação total. Gerar UMA vez com:
  //   npx web-push generate-vapid-keys
  // Guardar em secret manager. Em prod, PUSH_ENABLED=true exige ambas
  // (cross-field abaixo). Em dev, ausência só desliga a feature.
  PUSH_ENABLED: z.coerce.boolean().optional().default(false),
  VAPID_PUBLIC_KEY: z.string().optional().or(z.literal('')),
  VAPID_PRIVATE_KEY: z.string().optional().or(z.literal('')),
  // Subject obrigatório pelo VAPID spec — mailto: ou https://. Identifica
  // o servidor pro Push Service em caso de abuso. Default mailto: aceitável.
  VAPID_SUBJECT: z.string().optional().default('mailto:notifications@apex-training.local'),

  // Voice Diary IA (PR #25) — feature toggle.
  // Sem key, endpoint /api/voice/* retorna 503 (feature off).
  // Em prod, se VOICE_ENABLED=true a key vira obrigatória (cross-field abaixo).
  VOICE_ENABLED: z.coerce.boolean().optional().default(false),
  ANTHROPIC_API_KEY: z.string().optional().or(z.literal('')),
  // Modelo override (testes podem trocar). Default Haiku 4.5 — barato, rápido pt-BR.
  ANTHROPIC_MODEL: z.string().optional().default('claude-haiku-4-5-20251001'),

  // Sentry (PR #34) — observabilidade opcional.
  // Sem DSN → init no-op (zero overhead em dev/test). Setar em prod via secret.
  SENTRY_DSN: z.string().optional().or(z.literal('')),
  // Ambiente reportado ao Sentry. Default usa NODE_ENV pra evitar
  // misturar erros de dev/staging/prod no mesmo project.
  SENTRY_ENVIRONMENT: z.string().optional().or(z.literal('')),
  // Sample rate de performance (0..1). Default 0.1 = 10% das requests
  // pra não explodir quota gratuita do Sentry SaaS.
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).optional().default(0.1),
  // SHA do commit pra correlacionar deploy + release Sentry. CI seta isso.
  SENTRY_RELEASE: z.string().optional().or(z.literal('')),
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

  // PR #41a — Webhook é opcional; mas as duas vars viajam juntas (verify
  // token sem callback não registra subscription, e vice-versa).
  if (Boolean(parsed.STRAVA_VERIFY_TOKEN) !== Boolean(parsed.STRAVA_WEBHOOK_CALLBACK_URL)) {
    errors.push('Configuração de webhook Strava parcial. Setar STRAVA_VERIFY_TOKEN e STRAVA_WEBHOOK_CALLBACK_URL juntos.');
  }
  if (parsed.STRAVA_VERIFY_TOKEN && !parsed.STRAVA_CLIENT_ID) {
    errors.push('Webhook Strava exige OAuth configurado (STRAVA_CLIENT_ID/SECRET).');
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

  // Voice Diary IA — feature flag exige key em prod.
  if (parsed.VOICE_ENABLED && !parsed.ANTHROPIC_API_KEY) {
    if (isProd) {
      errors.push('VOICE_ENABLED=true em produção exige ANTHROPIC_API_KEY.');
    } else {
      warnings.push('VOICE_ENABLED=true sem ANTHROPIC_API_KEY. Endpoint /api/voice retornará 503.');
    }
  }

  // Web Push (PR #26) — VAPID keys obrigatórias quando feature ON.
  // Em prod, falta de qualquer das duas é fatal: subscriptions existentes
  // ficariam órfãs sem dispatch.
  if (parsed.PUSH_ENABLED && (!parsed.VAPID_PUBLIC_KEY || !parsed.VAPID_PRIVATE_KEY)) {
    if (isProd) {
      errors.push('PUSH_ENABLED=true em produção exige VAPID_PUBLIC_KEY e VAPID_PRIVATE_KEY.');
    } else {
      warnings.push('PUSH_ENABLED=true sem chaves VAPID completas. /api/push retornará 503.');
    }
  }
  // Endpoints subscribe/test ainda funcionam só com pública? NÃO — sem
  // privada não conseguimos assinar payloads. Tratar como par atômico.
  if (Boolean(parsed.VAPID_PUBLIC_KEY) !== Boolean(parsed.VAPID_PRIVATE_KEY)) {
    errors.push('VAPID_PUBLIC_KEY e VAPID_PRIVATE_KEY devem ser setadas juntas.');
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
    // PR #41a — webhook é subset opcional da feature Strava.
    stravaWebhookEnabled: Boolean(
      result.data.STRAVA_VERIFY_TOKEN && result.data.STRAVA_WEBHOOK_CALLBACK_URL,
    ),
    s3Enabled: Boolean(result.data.AWS_REGION && result.data.S3_BUCKET),
    voiceEnabled: Boolean(result.data.VOICE_ENABLED && result.data.ANTHROPIC_API_KEY),
    pushEnabled: Boolean(
      result.data.PUSH_ENABLED &&
      result.data.VAPID_PUBLIC_KEY &&
      result.data.VAPID_PRIVATE_KEY,
    ),
    sentryEnabled: Boolean(result.data.SENTRY_DSN) && result.data.NODE_ENV !== 'test',
  };
}

export const env = loadEnv();
