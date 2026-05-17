import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { iniciarTreinoSchema } from '../schemas/rotina.schemas.js';

// PR #14 (audit 4.19) — janela de tolerância em dataAlvo.

describe('iniciarTreinoSchema — janela temporal anti-tampering', () => {
  it('dataAlvo omitido → ok (service usa Date.now)', () => {
    assert.doesNotThrow(() => iniciarTreinoSchema.parse({}));
    assert.doesNotThrow(() => iniciarTreinoSchema.parse({ dataAlvo: undefined }));
  });

  it('dataAlvo agora → ok', () => {
    const iso = new Date().toISOString();
    assert.doesNotThrow(() => iniciarTreinoSchema.parse({ dataAlvo: iso }));
  });

  it('dataAlvo 1 min no futuro → ok (dentro da tolerância de clock drift)', () => {
    const iso = new Date(Date.now() + 60_000).toISOString();
    assert.doesNotThrow(() => iniciarTreinoSchema.parse({ dataAlvo: iso }));
  });

  it('dataAlvo 6 min no futuro → rejeita', () => {
    const iso = new Date(Date.now() + 6 * 60_000).toISOString();
    assert.throws(() => iniciarTreinoSchema.parse({ dataAlvo: iso }));
  });

  it('dataAlvo 3 dias no passado → ok (offline-first registra retroativo)', () => {
    const iso = new Date(Date.now() - 3 * 86_400_000).toISOString();
    assert.doesNotThrow(() => iniciarTreinoSchema.parse({ dataAlvo: iso }));
  });

  it('dataAlvo 8 dias no passado → rejeita (fora da janela)', () => {
    const iso = new Date(Date.now() - 8 * 86_400_000).toISOString();
    assert.throws(() => iniciarTreinoSchema.parse({ dataAlvo: iso }));
  });

  it('string não-datetime → rejeita (z.string().datetime())', () => {
    assert.throws(() => iniciarTreinoSchema.parse({ dataAlvo: 'amanhã às 7' }));
  });

  it('campos extras NÃO são rejeitados (schema permissivo no envelope)', () => {
    // iniciarTreinoSchema não tem .strict() — o controller só lê `dataAlvo`.
    // Documenta o comportamento atual.
    const out = iniciarTreinoSchema.parse({ dataAlvo: new Date().toISOString(), extra: 'ok' });
    assert.ok(out.dataAlvo);
  });
});
