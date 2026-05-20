import crypto from 'node:crypto';
import { z } from 'zod';

import {
  connect,
  disconnect,
  status,
  syncAtividades,
  listAtividades,
  processWebhookEvent,
} from '../services/strava.service.js';
import { HttpError } from '../middleware/errorHandler.js';
import { env } from '../lib/env.js';

// state: defesa em camadas — frontend valida a igualdade entre URL e
// sessionStorage. Aqui validamos apenas o FORMATO (presença + forma
// base64url + tamanho razoável). Comparação semântica não é possível
// no backend porque o state é client-side (sessionStorage), por design.
// Validar formato impede que requests sem state cheguem no `exchangeCode`.
const connectSchema = z.object({
  code: z.string().min(1, 'Code obrigatório'),
  state: z
    .string()
    .min(16, 'State muito curto')
    .max(128, 'State muito longo')
    .regex(/^[A-Za-z0-9_-]+$/, 'State em formato inválido'),
});

function ensureAluno(req) {
  if (req.user.role !== 'ALUNO') throw new HttpError(403, 'Apenas alunos têm Strava');
}

export async function conectar(req, res, next) {
  try {
    ensureAluno(req);
    // `state` é validado por formato (Zod). O service não usa o valor —
    // a verdade da igualdade fica no client. Mantemos a presença aqui
    // como contrato explícito: qualquer cliente que chame /strava/connect
    // SEM state recebe 400 antes de tocar o Strava API.
    const { code } = connectSchema.parse(req.body);
    const result = await connect(req.user.userId, code);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function desconectar(req, res, next) {
  try {
    ensureAluno(req);
    const result = await disconnect(req.user.userId);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function obterStatus(req, res, next) {
  try {
    ensureAluno(req);
    const data = await status(req.user.userId);
    res.json(data);
  } catch (err) {
    next(err);
  }
}

export async function sincronizar(req, res, next) {
  try {
    ensureAluno(req);
    const result = await syncAtividades(req.user.userId);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function atividades(req, res, next) {
  try {
    const limit = req.query.limit ? Number(req.query.limit) : 50;
    const data = await listAtividades({
      user: req.user,
      alunoId: req.params.alunoId,
      limit,
    });
    res.json({ atividades: data });
  } catch (err) {
    next(err);
  }
}

// ─── PR #41a — Webhook handlers (público, sem JWT) ──────────────────
//
// Strava chama:
//   GET  /api/strava/webhook?hub.mode=subscribe
//                          &hub.verify_token=<nosso token>
//                          &hub.challenge=<string random>
//     → devemos retornar 200 JSON com { "hub.challenge": "<string>" }
//
//   POST /api/strava/webhook
//     body: { object_type, aspect_type, object_id, owner_id, ... }
//     → devemos retornar 200 vazio em < 2s.
//
// Sem JWT do nosso sistema — Strava não tem auth bidirecional. Defesa:
//   GET:  validamos hub.verify_token via constant-time compare.
//   POST: aceitamos todos (Strava não assina). Service valida shape
//         + verifica owner conhecido. Idempotência por stravaId.

const webhookVerifySchema = z.object({
  'hub.mode': z.literal('subscribe'),
  'hub.verify_token': z.string().min(1),
  'hub.challenge': z.string().min(1),
});

// Compara strings constant-time pra evitar timing attack ao adivinhar
// verify_token byte por byte. Strava é fonte conhecida mas é higiene.
function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export async function webhookVerify(req, res, next) {
  try {
    if (!env.stravaWebhookEnabled) {
      throw new HttpError(503, 'Webhook Strava desabilitado (feature off)');
    }
    const parsed = webhookVerifySchema.parse(req.query);
    if (!constantTimeEqual(parsed['hub.verify_token'], env.STRAVA_VERIFY_TOKEN)) {
      // 403 explícito (e não 401) — Strava entende como "config incorreto"
      // e mostra erro claro no dashboard de subscriptions.
      throw new HttpError(403, 'verify_token inválido');
    }
    // Resposta exata exigida pelo Strava: chave literal "hub.challenge"
    // (com ponto). Spec: https://developers.strava.com/docs/webhooks/
    res.status(200).json({ 'hub.challenge': parsed['hub.challenge'] });
  } catch (err) {
    next(err);
  }
}

const webhookEventSchema = z.object({
  object_type: z.string(),
  object_id: z.union([z.number(), z.string()]).optional(),
  aspect_type: z.enum(['create', 'update', 'delete']).optional(),
  owner_id: z.union([z.number(), z.string()]).optional(),
  subscription_id: z.union([z.number(), z.string()]).optional(),
  event_time: z.number().optional(),
  updates: z.record(z.unknown()).optional(),
}).passthrough();

export async function webhookEvent(req, res) {
  // Sem `next`: handler de webhook NUNCA delega pro errorHandler global
  // — sempre responde 200 (Strava retenta em 5xx/timeout, queremos evitar
  // thundering herd). Erros vão pra log/Sentry mas não causam retry.
  if (!env.stravaWebhookEnabled) {
    // Não 503 aqui — se desligamos mas Strava ainda tem subscription,
    // ack pra ele não retentar até infinito. Log pra observabilidade.
    console.warn('[strava-webhook] evento recebido com webhook desabilitado');
    return res.status(200).end();
  }

  // safeParse pra evitar throw síncrono no node:test (vira unhandledRejection)
  // + intenção: payload malformado é "ignora silencioso", não erro.
  const parsed = webhookEventSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    console.warn('[strava-webhook] payload inválido', parsed.error.issues?.slice(0, 3));
    return res.status(200).end();
  }

  try {
    // Strava exige resposta < 2s. Operação aqui é leve (fetch + upsert),
    // mas se virar gargalo no PR #41b+, considerar fila (BullMQ/SQS) e
    // responder 200 imediato.
    const result = await processWebhookEvent(parsed.data);

    // 200 vazio é o que Strava espera. Logging interno só.
    if (result.processed) {
      console.log('[strava-webhook]', result);
    } else {
      console.log('[strava-webhook] ignored', result);
    }
    res.status(200).end();
  } catch (err) {
    // Async errors do fetch/upsert: log + Sentry, sempre 200.
    console.error('[strava-webhook] erro processando evento', err?.message || err);
    res.status(200).end();
  }
}
