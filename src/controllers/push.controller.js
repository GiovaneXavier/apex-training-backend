import { env } from '../lib/env.js';
import { HttpError } from '../middleware/errorHandler.js';
import { subscribeSchema, unsubscribeSchema, notificationPayloadSchema } from '../schemas/push.schemas.js';
import {
  dispatch,
  deleteSubscription,
  getVapidPublicKey,
  saveSubscription,
} from '../services/push.service.js';

// PR #26 — handlers de Web Push.
//
// Política ACL: subscriptions são por user (não por aluno). PROFESSOR e
// NUTRICIONISTA também podem subscrever pros próprios push (ex: "novo
// vínculo solicitado"). ALUNO recebe alertas de treino/IBJJF (PR #27).

export async function vapidPublicKey(req, res, next) {
  try {
    res.json({ key: getVapidPublicKey() });
  } catch (err) {
    next(err);
  }
}

export async function subscribe(req, res, next) {
  try {
    if (!env.pushEnabled) throw new HttpError(503, 'Push desabilitado');

    const data = subscribeSchema.parse(req.body);
    // userAgent server-side é mais confiável que o que o cliente manda,
    // mas o cliente pode passar pra distinguir "Chrome desktop" vs "PWA
    // instalado". Aceitamos string custom, com fallback no header.
    const userAgent = data.userAgent || req.get('user-agent') || null;

    const sub = await saveSubscription({
      userId: req.user.userId,
      endpoint: data.endpoint,
      p256dh: data.keys.p256dh,
      auth: data.keys.auth,
      userAgent,
    });

    res.status(201).json({
      id: sub.id,
      endpoint: sub.endpoint,
      createdAt: sub.createdAt,
    });
  } catch (err) {
    next(err);
  }
}

export async function unsubscribe(req, res, next) {
  try {
    if (!env.pushEnabled) throw new HttpError(503, 'Push desabilitado');

    const data = unsubscribeSchema.parse(req.body);
    const result = await deleteSubscription({
      userId: req.user.userId,
      endpoint: data.endpoint,
    });
    if (result.count === 0) {
      // Nada deletado: ou o endpoint não era do user, ou já estava deletado.
      // Em ambos os casos, do POV do client, "subscription não existe" =
      // 204 idempotente. Não vazamos qual dos dois cenários.
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}

// POST /push/test — dev/QA only. Envia um push fixture pro próprio user.
// Bloqueado em produção pra evitar abuse (e gastar quota gratuita do
// FCM/Mozilla).
export async function sendTest(req, res, next) {
  try {
    if (!env.pushEnabled) throw new HttpError(503, 'Push desabilitado');
    if (env.isProd) throw new HttpError(404, 'Endpoint de teste indisponível em produção');

    const payload = notificationPayloadSchema.parse({
      title: req.body?.title || 'Apex Training — teste',
      body: req.body?.body || 'Web Push está funcionando 🚀',
      url: req.body?.url || '/',
    });

    const stats = await dispatch({ userId: req.user.userId, payload });
    res.json(stats);
  } catch (err) {
    next(err);
  }
}
