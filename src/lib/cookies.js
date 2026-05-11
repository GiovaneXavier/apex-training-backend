import { env } from './env.js';

// Cookie de autenticação — config centralizada.
//
// HttpOnly:  inacessível ao JS → mitiga XSS exfiltrar o JWT.
// Secure:    só HTTPS em prod (cookies em http://localhost ficariam órfãos).
// SameSite:
//   - dev:   'lax' (mesmo origem localhost, fluxos cross-tab OK).
//   - prod:  'none' — frontend (Vercel) e API (Render) ficam em eTLD+1
//            diferentes; sem 'none' o browser bloqueia o cookie em POST
//            cross-site e o login simplesmente não funciona. 'none' EXIGE
//            'secure: true' — daí o gate por env.isProd.
//
// Defesa contra CSRF NÃO depende deste SameSite — usamos double-submit
// pattern com token no header (ver middleware/csrf). O SameSite é só
// camada extra; em prod cross-site somos forçados a 'none'.

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export function authCookieOptions() {
  return {
    httpOnly: true,
    secure: env.isProd,
    sameSite: env.isProd ? 'none' : 'lax',
    maxAge: ONE_WEEK_MS,
    path: '/',
  };
}

export function clearAuthCookieOptions() {
  return {
    httpOnly: true,
    secure: env.isProd,
    sameSite: env.isProd ? 'none' : 'lax',
    path: '/',
    maxAge: 0,
  };
}
