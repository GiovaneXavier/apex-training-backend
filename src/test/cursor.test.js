import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { encodeCursor, decodeCursor } from '../lib/cursor.js';

describe('cursor — encode/decode roundtrip', () => {
  it('roundtrip preserva campos', () => {
    const original = { lastCriadoEm: '2026-05-24T12:00:00.000Z', lastId: 'clxxx123' };
    const enc = encodeCursor(original);
    const dec = decodeCursor(enc);
    assert.deepEqual(dec, original);
  });

  it('encode produz base64url (sem +, /, =)', () => {
    const enc = encodeCursor({ lastCriadoEm: '2026-05-24T12:00:00.000Z', lastId: 'clxxx' });
    assert.match(enc, /^[A-Za-z0-9_-]+$/, `cursor não é base64url puro: ${enc}`);
  });

  it('decode de null/vazio → null', () => {
    assert.equal(decodeCursor(null), null);
    assert.equal(decodeCursor(undefined), null);
    assert.equal(decodeCursor(''), null);
  });

  it('decode de payload acima de MAX_CURSOR_BYTES → throw', () => {
    const huge = 'a'.repeat(600);
    assert.throws(() => decodeCursor(huge), /cursor inválido/);
  });

  it('decode de base64 inválido → throw', () => {
    assert.throws(() => decodeCursor('!!!nope!!!'), /cursor inválido/);
  });

  it('decode de tipo errado (number) → throw', () => {
    assert.throws(() => decodeCursor(123), /cursor inválido/);
  });

  it('encode rejeita payload null/undefined', () => {
    assert.throws(() => encodeCursor(null), /payload obrigatório/);
    assert.throws(() => encodeCursor(undefined), /payload obrigatório/);
  });

  it('encode preserva chars unicode no payload', () => {
    const original = { lastCriadoEm: '2026-05-24T12:00:00.000Z', lastId: 'çü', nome: 'João 🚀' };
    const dec = decodeCursor(encodeCursor(original));
    assert.deepEqual(dec, original);
  });
});
