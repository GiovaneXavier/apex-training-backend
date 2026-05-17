import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { clonarTreinoSchema } from '../schemas/treino.schemas.js';

// PR #16 — janela temporal de dataAlvo em clonarTreinoSchema.
describe('clonarTreinoSchema — janela [-90d, +180d]', () => {
  it('aceita 7 dias no futuro', () => {
    const iso = new Date(Date.now() + 7 * 86_400_000).toISOString();
    assert.doesNotThrow(() => clonarTreinoSchema.parse({ dataAlvo: iso }));
  });

  it('aceita 90 dias no futuro', () => {
    const iso = new Date(Date.now() + 90 * 86_400_000).toISOString();
    assert.doesNotThrow(() => clonarTreinoSchema.parse({ dataAlvo: iso }));
  });

  it('rejeita 200 dias no futuro (além de 180)', () => {
    const iso = new Date(Date.now() + 200 * 86_400_000).toISOString();
    assert.throws(() => clonarTreinoSchema.parse({ dataAlvo: iso }));
  });

  it('aceita 30 dias no passado', () => {
    const iso = new Date(Date.now() - 30 * 86_400_000).toISOString();
    assert.doesNotThrow(() => clonarTreinoSchema.parse({ dataAlvo: iso }));
  });

  it('rejeita 100 dias no passado (além de 90)', () => {
    const iso = new Date(Date.now() - 100 * 86_400_000).toISOString();
    assert.throws(() => clonarTreinoSchema.parse({ dataAlvo: iso }));
  });

  it('rejeita string não-datetime', () => {
    assert.throws(() => clonarTreinoSchema.parse({ dataAlvo: 'semana que vem' }));
  });

  it('rejeita dataAlvo ausente (obrigatório, diferente do iniciarTreino)', () => {
    assert.throws(() => clonarTreinoSchema.parse({}));
  });
});
