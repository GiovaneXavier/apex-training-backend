import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from './env.js';

// AES-256-GCM. Formato persistido:
//   enc:v1:<iv_b64>:<tag_b64>:<ct_b64>
//
// Por que prefixo versionado:
//   - Rollover de algoritmo (v2 futuro) sem migration brutal.
//   - Leitura detecta legado (sem prefixo = plaintext) e devolve direto.
//     Útil pra migrar valores existentes lazy: lê plain → re-grava cifrado
//     na próxima atualização do registro.
//
// Por que GCM:
//   - Confidencialidade + integridade autenticada (auth tag).
//   - Tampering no banco quebra decrypt em vez de gerar plaintext arbitrário.
//
// Por que IV per-encrypt (12 bytes):
//   - GCM perde segurança total com IV reused na mesma key (nonce-misuse).
//   - 12 bytes = recomendação NIST SP 800-38D.

const PREFIX = 'enc:v1:';
const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

let cachedKey = null;
function getKey() {
  if (cachedKey) return cachedKey;
  if (!env.STRAVA_TOKEN_KEY) return null; // dev sem chave: passthrough
  const buf = Buffer.from(env.STRAVA_TOKEN_KEY, 'base64');
  if (buf.length !== 32) {
    // Esta validação também roda em env.js no boot; aqui é defense-in-depth
    // caso alguém importe crypto antes do env carregar (ex. em testes).
    throw new Error('STRAVA_TOKEN_KEY decodada ≠ 32 bytes (AES-256)');
  }
  cachedKey = buf;
  return cachedKey;
}

/** True se a string já está no formato cifrado v1. */
export function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

/**
 * Cifra string UTF-8. Retorna no formato `enc:v1:iv:tag:ct` (base64).
 * Sem chave (dev): passthrough — env.js já bloqueia esse caminho em prod.
 * null/undefined entram e saem inalterados — facilita usar em campos opcionais.
 */
export function encrypt(plaintext) {
  if (plaintext == null) return plaintext;
  if (typeof plaintext !== 'string') {
    throw new TypeError('encrypt: esperado string, recebeu ' + typeof plaintext);
  }
  if (isEncrypted(plaintext)) return plaintext; // idempotência — evita dupla cifragem

  const key = getKey();
  if (!key) return plaintext;

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

/**
 * Decifra string cifrada v1. Plaintext legado (sem prefixo) passa direto —
 * window de migração transparente para tokens Strava persistidos antes desta
 * mudança. Em prod com chave obrigatória, ainda assim aceita legado se algum
 * registro escapou da reencrypt — não quebra o fluxo de refresh.
 *
 * Lança erro só se: dados marcados como cifrados (v1) mas formato corrompido
 * ou chave ausente — sinal de configuração quebrada, não de uso normal.
 */
export function decrypt(value) {
  if (value == null) return value;
  if (typeof value !== 'string') {
    throw new TypeError('decrypt: esperado string, recebeu ' + typeof value);
  }
  if (!isEncrypted(value)) return value; // legado: plaintext direto

  const key = getKey();
  if (!key) {
    throw new Error('Valor cifrado mas STRAVA_TOKEN_KEY ausente — não dá pra decrypt');
  }

  const parts = value.slice(PREFIX.length).split(':');
  if (parts.length !== 3) throw new Error('Token cifrado corrompido (formato)');
  const [ivB64, tagB64, ctB64] = parts;

  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const ct = Buffer.from(ctB64, 'base64');
  if (iv.length !== IV_BYTES) throw new Error('Token cifrado corrompido (IV size)');
  if (tag.length !== TAG_BYTES) throw new Error('Token cifrado corrompido (tag size)');

  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  // .final() lança se auth tag não bate → tampering ou key errada
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString('utf8');
}

/**
 * Comparação resistente a timing-attack para strings que carregam segredo
 * (CSRF tokens, OAuth state, etc.). Útil em PR seguintes — exporta aqui pra
 * centralizar primitivas crypto.
 */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
