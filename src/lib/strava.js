// Strava API helpers — OAuth token exchange + activities fetch.
// PR #41a (Sprint 15) — estende com fetchActivity (single) + push subscriptions API.
// Usa fetch global (Node 20+).
import { HttpError } from '../middleware/errorHandler.js';

const TOKEN_URL = 'https://www.strava.com/oauth/token';
const API_BASE = 'https://www.strava.com/api/v3';
// Push subscriptions API — endpoint diferente da API regular.
const PUSH_SUBSCRIPTIONS_URL = 'https://www.strava.com/api/v3/push_subscriptions';

function clientCredentials() {
  const id = process.env.STRAVA_CLIENT_ID;
  const secret = process.env.STRAVA_CLIENT_SECRET;
  if (!id || !secret) {
    throw new Error('STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET não configurados');
  }
  return { id, secret };
}

export async function exchangeCode(code) {
  const { id, secret } = clientCredentials();
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: id,
      client_secret: secret,
      code,
      grant_type: 'authorization_code',
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Causa #1: code expirado/consumido. Strava devolve 400 com
    // `errors: [{ code: 'invalid', field: 'code' }]` ou message "Bad Request".
    // Surfaceia como 502 (upstream falhou) com mensagem útil, em vez de
    // 500 cego pelo errorHandler global.
    const detalhe = json?.errors?.[0]?.code === 'invalid'
      ? 'Código OAuth expirado ou já usado. Tente conectar novamente.'
      : (json?.message || 'Erro desconhecido do Strava');
    throw new HttpError(502, `Falha na autorização Strava (${res.status}): ${detalhe}`);
  }
  return json; // { access_token, refresh_token, expires_at, athlete: { id, ... } }
}

export async function refreshAccessToken(refreshToken) {
  const { id, secret } = clientCredentials();
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: id,
      client_secret: secret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new HttpError(502, `Strava refresh token falhou (${res.status}). Reconecte a conta Strava.`);
  }
  return json;
}

export async function fetchActivities(accessToken, { after, perPage = 30, page = 1 } = {}) {
  const url = new URL(`${API_BASE}/athlete/activities`);
  if (after) url.searchParams.set('after', String(Math.floor(after / 1000)));
  url.searchParams.set('per_page', String(perPage));
  url.searchParams.set('page', String(page));
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new HttpError(502, `Strava activities falhou (${res.status}). ${text.slice(0, 120)}`);
  }
  return res.json();
}

// PR #41a — Fetch de UMA atividade específica via ID.
// Usado pelo webhook handler: evento chega com `object_id` (activity id);
// precisamos buscar o detalhe completo da atividade pra persistir.
//
// Retorno: payload completo do Strava (mesmo shape de fetchActivities[N]),
// com campos extras que só vêm no endpoint singular (description, gear, ...).
export async function fetchActivity(accessToken, activityId) {
  const url = new URL(`${API_BASE}/activities/${activityId}`);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 404) {
    // Atividade deletada antes de processarmos o evento. Não é erro nosso.
    return null;
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new HttpError(502, `Strava activity fetch falhou (${res.status}). ${text.slice(0, 120)}`);
  }
  return res.json();
}

// ─── Push Subscriptions API (PR #41a) ─────────────────────────────────
//
// Strava só permite UMA subscription por aplicação (client_id). Operações:
//   - POST   /push_subscriptions      cria (validação síncrona via GET no callback)
//   - GET    /push_subscriptions      lista (deveria retornar 0 ou 1)
//   - DELETE /push_subscriptions/:id  remove
//
// Auth é client_id + client_secret no BODY (não Bearer token) — diferente
// das outras rotas. É a única chamada Strava que usa esse padrão.

export async function listWebhookSubscriptions() {
  const { id, secret } = clientCredentials();
  const url = new URL(PUSH_SUBSCRIPTIONS_URL);
  url.searchParams.set('client_id', id);
  url.searchParams.set('client_secret', secret);
  const res = await fetch(url);
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    throw new HttpError(502, `Strava list subscriptions falhou (${res.status}). ${JSON.stringify(json).slice(0, 200)}`);
  }
  return Array.isArray(json) ? json : [];
}

export async function registerWebhookSubscription({ callbackUrl, verifyToken }) {
  const { id, secret } = clientCredentials();
  // Strava exige form-urlencoded, não JSON.
  const body = new URLSearchParams({
    client_id: id,
    client_secret: secret,
    callback_url: callbackUrl,
    verify_token: verifyToken,
  });
  const res = await fetch(PUSH_SUBSCRIPTIONS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    // Causa típica de falha:
    //   - callback_url inacessível (firewall/ngrok off)
    //   - GET no callback não devolveu hub.challenge esperado
    //   - já existe subscription (Strava limita 1 por app)
    const detalhe = json?.errors?.[0]?.resource
      ? `${json.errors[0].resource} ${json.errors[0].code}`
      : (json?.message || JSON.stringify(json).slice(0, 200));
    throw new HttpError(502, `Strava register subscription falhou (${res.status}): ${detalhe}`);
  }
  return json; // { id, application_id, callback_url, ... }
}

export async function deleteWebhookSubscription(subscriptionId) {
  const { id, secret } = clientCredentials();
  const url = new URL(`${PUSH_SUBSCRIPTIONS_URL}/${subscriptionId}`);
  url.searchParams.set('client_id', id);
  url.searchParams.set('client_secret', secret);
  const res = await fetch(url, { method: 'DELETE' });
  if (!res.ok && res.status !== 404) {
    const text = await res.text().catch(() => '');
    throw new HttpError(502, `Strava delete subscription falhou (${res.status}). ${text.slice(0, 120)}`);
  }
  return { ok: true };
}
