// Strava API helpers — OAuth token exchange + activities fetch.
// Usa fetch global (Node 20+).
import { HttpError } from '../middleware/errorHandler.js';

const TOKEN_URL = 'https://www.strava.com/oauth/token';
const API_BASE = 'https://www.strava.com/api/v3';

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
