import { z } from 'zod';

// PR #26 — Web Push subscription shape.
//
// Espelha PushSubscription.toJSON() do navegador (W3C Push API).
// p256dh / auth são base64url (sem padding) gerados pelo browser ao
// chamar registration.pushManager.subscribe(). Validamos formato pra
// rejeitar payload arbitrário antes de ir pro DB.

// Base64url permite [A-Za-z0-9_-] e sem '=' de padding. Em alguns
// browsers vem com padding mesmo — aceitamos ambos.
const base64urlish = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9_\-=]+$/, 'Deve ser base64url');

export const subscribeSchema = z
  .object({
    endpoint: z
      .string()
      .url('endpoint deve ser URL HTTPS')
      .max(2048)
      .startsWith('https://', 'endpoint precisa ser HTTPS'),
    keys: z
      .object({
        p256dh: base64urlish,
        auth: base64urlish,
      })
      .strict(),
    userAgent: z.string().max(512).optional(),
  })
  .strict();

export const unsubscribeSchema = z
  .object({
    endpoint: z.string().url().max(2048),
  })
  .strict();

// Payload tipado pra dispatch interno. Define o contrato que o SW vai
// consumir no event.data.json(). Mantemos pequeno por causa do limite de
// 4KB do Push Service (FCM/APNs).
export const notificationPayloadSchema = z
  .object({
    title: z.string().min(1).max(120),
    body: z.string().max(300).optional(),
    url: z.string().max(512).optional(),    // pra onde o click leva
    tag: z.string().max(64).optional(),     // colapsa notifs duplicadas no SO
    icon: z.string().url().max(512).optional(),
  })
  .strict();
