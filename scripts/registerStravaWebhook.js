#!/usr/bin/env node
/**
 * PR #41a — Script CLI pra gerenciar Strava Webhook subscription.
 *
 * Strava só permite UMA subscription por aplicação (client_id). Este script
 * é fonte da verdade pra criar, listar e remover essa subscription.
 *
 * Uso:
 *   node scripts/registerStravaWebhook.js list        # mostra subscription atual (ou null)
 *   node scripts/registerStravaWebhook.js register    # cria nova (apaga existente se houver)
 *   node scripts/registerStravaWebhook.js delete      # apaga existente
 *
 * Lê do .env:
 *   STRAVA_CLIENT_ID
 *   STRAVA_CLIENT_SECRET
 *   STRAVA_VERIFY_TOKEN
 *   STRAVA_WEBHOOK_CALLBACK_URL
 *
 * Pré-requisitos:
 *   - Endpoint /api/strava/webhook acessível publicamente no CALLBACK_URL.
 *     Em dev: rode `ngrok http 3000` e exporte STRAVA_WEBHOOK_CALLBACK_URL
 *     com a URL do túnel + path /api/strava/webhook.
 *   - Backend rodando (npm run dev) — Strava faz GET no callback como parte
 *     do registro pra validar.
 */

import 'dotenv/config';

import {
  listWebhookSubscriptions,
  registerWebhookSubscription,
  deleteWebhookSubscription,
} from '../src/lib/strava.js';

function requireEnv(name) {
  const val = process.env[name];
  if (!val) {
    console.error(`[strava-webhook] env ${name} não setada. Veja .env.example.`);
    process.exit(1);
  }
  return val;
}

async function cmdList() {
  const subs = await listWebhookSubscriptions();
  if (subs.length === 0) {
    console.log('[strava-webhook] nenhuma subscription ativa.');
    return;
  }
  for (const s of subs) {
    console.log(`[strava-webhook] sub #${s.id}`);
    console.log(`  callback_url: ${s.callback_url}`);
    console.log(`  created_at:   ${s.created_at}`);
    console.log(`  updated_at:   ${s.updated_at}`);
  }
}

async function cmdRegister() {
  requireEnv('STRAVA_CLIENT_ID');
  requireEnv('STRAVA_CLIENT_SECRET');
  const verifyToken = requireEnv('STRAVA_VERIFY_TOKEN');
  const callbackUrl = requireEnv('STRAVA_WEBHOOK_CALLBACK_URL');

  // Strava só permite 1 subscription por app — verifica e deleta antes.
  const existing = await listWebhookSubscriptions();
  if (existing.length > 0) {
    console.log(`[strava-webhook] já existe sub #${existing[0].id} (${existing[0].callback_url}). Removendo antes de recriar...`);
    await deleteWebhookSubscription(existing[0].id);
  }

  console.log(`[strava-webhook] registrando subscription com callback ${callbackUrl}...`);
  console.log('[strava-webhook] Strava vai fazer GET no callback agora. Certifique-se que o backend está rodando.');

  const sub = await registerWebhookSubscription({ callbackUrl, verifyToken });
  console.log(`[strava-webhook] sucesso. Subscription #${sub.id} criada.`);
  console.log(JSON.stringify(sub, null, 2));
}

async function cmdDelete() {
  const existing = await listWebhookSubscriptions();
  if (existing.length === 0) {
    console.log('[strava-webhook] nada pra deletar.');
    return;
  }
  for (const s of existing) {
    console.log(`[strava-webhook] deletando sub #${s.id}...`);
    await deleteWebhookSubscription(s.id);
  }
  console.log('[strava-webhook] ok.');
}

const cmd = process.argv[2];
const handlers = { list: cmdList, register: cmdRegister, delete: cmdDelete };

if (!handlers[cmd]) {
  console.error('Uso: node scripts/registerStravaWebhook.js [list|register|delete]');
  process.exit(2);
}

handlers[cmd]().catch((err) => {
  console.error('[strava-webhook] falha:', err.message || err);
  process.exit(1);
});
