import * as Sentry from '@sentry/node';

import { env } from './env.js';

// PR #34 — Observabilidade backend (Sprint 13).
//
// Init no-op quando SENTRY_DSN ausente OU env=test. Zero overhead em
// dev/test. Em prod sem DSN setado, app sobe normal — apenas sem
// reporte de erro (warning no boot).
//
// SAMPLE RATE conservador (0.1 = 10%) — controla quota gratuita do
// Sentry SaaS. Override via SENTRY_TRACES_SAMPLE_RATE em prod high-traffic.
//
// CALLED ANTES DE TUDO no index.js — Sentry precisa enganchar os requires
// pra instrumentar http/express automaticamente.

let initialized = false;

export function initSentry() {
  if (initialized) return;
  if (!env.sentryEnabled) {
    if (env.isProd && !env.SENTRY_DSN) {
      console.warn('[sentry] SENTRY_DSN ausente em produção — observabilidade DESLIGADA.');
    }
    return;
  }
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.SENTRY_ENVIRONMENT || env.NODE_ENV,
    release: env.SENTRY_RELEASE || undefined,
    tracesSampleRate: env.SENTRY_TRACES_SAMPLE_RATE,
    // ProfilesSampleRate fica desligado por padrão — adiciona overhead e
    // não é essencial pra v1 de observabilidade.
    integrations: [
      // Auto-instrumenta HTTP/Express/Postgres. SDK detecta libs sem precisar listar.
    ],
    // Filtro de ruído: erros HttpError 4xx são "rejeição esperada" do app
    // (auth fail, validação Zod), não bug. NÃO reportar — polui dashboard.
    beforeSend(event, hint) {
      const err = hint?.originalException;
      const status = err?.status ?? err?.statusCode;
      if (typeof status === 'number' && status >= 400 && status < 500) {
        return null; // descarta
      }
      return event;
    },
  });
  initialized = true;
  console.log('[sentry] init ok', {
    env: env.SENTRY_ENVIRONMENT || env.NODE_ENV,
    sampleRate: env.SENTRY_TRACES_SAMPLE_RATE,
  });
}

// Hook explícito pra capturar erros 5xx no errorHandler. Express SDK
// v10 instrumenta via middleware auto, mas o nosso errorHandler já
// formata HttpError — então chamamos manualmente pra ter controle.
export function captureUnexpectedError(err, ctx = {}) {
  if (!initialized) return;
  // Tag de origem ajuda a separar erros 5xx genéricos vs sub-sistemas.
  Sentry.captureException(err, {
    contexts: { apex: ctx },
  });
}

// Test hook — reseta singleton entre suites.
export function __resetForTests() {
  initialized = false;
}

export { Sentry };
