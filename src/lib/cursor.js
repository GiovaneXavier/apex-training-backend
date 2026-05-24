// PR #43 (Sprint 16 — Bloco B) — Helpers de cursor opaco base64url.
//
// Cursor estável pra paginação onde a chave primária do sort pode ter
// colisão (ex: `criadoEm` com seed em massa). Carrega lastSortKey +
// lastId pra garantir empate-breaker determinístico.
//
// Formato decodificado: { lastCriadoEm: string ISO, lastId: string }
// Encoded: base64url da serialização JSON. URL-safe, ~60 chars.
//
// Por que opaco e não query params expostos: cursor é detalhe de
// implementação. Cliente NUNCA monta cursor manualmente — só passa
// adiante o que o backend devolveu. Trocar formato (adicionar campos,
// migrar de string pra timestamp) não quebra clientes.

const MAX_CURSOR_BYTES = 512; // sanity check anti-DoS

export function encodeCursor(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('encodeCursor: payload obrigatório');
  }
  const json = JSON.stringify(payload);
  return Buffer.from(json, 'utf8').toString('base64url');
}

export function decodeCursor(cursor) {
  if (cursor == null || cursor === '') return null;
  if (typeof cursor !== 'string') {
    throw new Error('cursor inválido');
  }
  if (cursor.length > MAX_CURSOR_BYTES) {
    throw new Error('cursor inválido');
  }
  let parsed;
  try {
    const json = Buffer.from(cursor, 'base64url').toString('utf8');
    parsed = JSON.parse(json);
  } catch {
    throw new Error('cursor inválido');
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('cursor inválido');
  }
  return parsed;
}
