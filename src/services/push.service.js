import webpush from 'web-push';

import { env } from '../lib/env.js';
import { prisma } from '../lib/prisma.js';
import { HttpError } from '../middleware/errorHandler.js';
import { notificationPayloadSchema } from '../schemas/push.schemas.js';

// PR #26 — Dispatcher único de Web Push.
//
// CONTRATO: call sites (PR #27 e além) chamam APENAS `dispatch()`.
// Nenhum controller toca `webpush.sendNotification` direto. Isso permite:
//   - mock único em testes
//   - retry/batch/queue futuro sem mudar call sites
//   - rate-limit por user pra evitar spam
//
// LIFECYCLE: subscription é descartável. Push Service que devolve 410 ou
// 404 = endpoint morto, deletamos inline. Outros erros (rede, timeout,
// 5xx do Push Service) NÃO deletam — podem ser transitórios.
//
// FAN-OUT: Promise.allSettled — uma sub quebrada não derruba as outras.
// User com PC + celular não perde push no celular porque o PC mudou de
// endpoint.

let vapidConfigured = false;
function ensureVapid() {
  if (vapidConfigured) return;
  if (!env.pushEnabled) {
    throw new HttpError(503, 'Push notifications desabilitado (feature off)');
  }
  webpush.setVapidDetails(
    env.VAPID_SUBJECT,
    env.VAPID_PUBLIC_KEY,
    env.VAPID_PRIVATE_KEY,
  );
  vapidConfigured = true;
}

// Hook pra testes — injeta cliente mock sem mexer em env real.
let _webpushImpl = webpush;
export function __setWebPushForTests(impl) {
  _webpushImpl = impl;
  vapidConfigured = true; // pula ensureVapid em teste
}
export function __resetWebPushForTests() {
  _webpushImpl = webpush;
  vapidConfigured = false;
}

/**
 * Envia uma notificação pra todos os devices ativos do user.
 *
 * @param {object} args
 * @param {string} args.userId        ID do User alvo.
 * @param {object} args.payload       Notificação (title, body, url...).
 *
 * @returns {Promise<{sent: number, dead: number, failed: number}>}
 *   Estatísticas — útil pra observabilidade e testes.
 */
export async function dispatch({ userId, payload }) {
  ensureVapid();

  const parsed = notificationPayloadSchema.parse(payload);
  const body = JSON.stringify(parsed);

  const subs = await prisma.pushSubscription.findMany({
    where: { userId },
    select: { id: true, endpoint: true, p256dh: true, auth: true },
  });

  if (subs.length === 0) {
    return { sent: 0, dead: 0, failed: 0 };
  }

  const results = await Promise.allSettled(
    subs.map((sub) =>
      _webpushImpl.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        body,
      ),
    ),
  );

  const deadIds = [];
  const usedIds = [];
  let failed = 0;

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const sub = subs[i];
    if (r.status === 'fulfilled') {
      usedIds.push(sub.id);
      continue;
    }
    // web-push reject com statusCode. 404/410 = sub morta.
    const code = r.reason?.statusCode;
    if (code === 404 || code === 410) {
      deadIds.push(sub.id);
    } else {
      // Transitório (5xx, timeout, network). Mantém sub, conta como falha.
      failed++;
      console.warn('[push] sub falhou (transitório)', { subId: sub.id, code, msg: r.reason?.message });
    }
  }

  // Cleanup + lastUsedAt em paralelo. Nenhum bloqueia o dispatch.
  const ops = [];
  if (deadIds.length > 0) {
    ops.push(prisma.pushSubscription.deleteMany({ where: { id: { in: deadIds } } }));
  }
  if (usedIds.length > 0) {
    ops.push(prisma.pushSubscription.updateMany({
      where: { id: { in: usedIds } },
      data: { lastUsedAt: new Date() },
    }));
  }
  if (ops.length > 0) await Promise.allSettled(ops);

  return { sent: usedIds.length, dead: deadIds.length, failed };
}

/**
 * Upsert por endpoint. Mesma device renovando = idempotente.
 * pushsubscriptionchange no SW chama unsubscribe(oldEndpoint) +
 * subscribe(new) — então não tentamos "rotacionar" aqui.
 */
export async function saveSubscription({ userId, endpoint, p256dh, auth, userAgent }) {
  return prisma.pushSubscription.upsert({
    where: { endpoint },
    create: { userId, endpoint, p256dh, auth, userAgent: userAgent || null },
    update: {
      userId,         // se mesma sub veio de outro user (raro), reattach
      p256dh, auth,   // chaves podem ter rotacionado
      userAgent: userAgent || null,
      lastUsedAt: new Date(),
    },
  });
}

export async function deleteSubscription({ userId, endpoint }) {
  // Filtro por userId E endpoint pra evitar que userA delete sub do userB
  // adivinhando endpoint. deleteMany devolve { count } — usar pra detectar
  // "não havia nada pra deletar" e retornar 404 honesto.
  return prisma.pushSubscription.deleteMany({
    where: { endpoint, userId },
  });
}

export function getVapidPublicKey() {
  if (!env.pushEnabled) {
    throw new HttpError(503, 'Push notifications desabilitado');
  }
  return env.VAPID_PUBLIC_KEY;
}
