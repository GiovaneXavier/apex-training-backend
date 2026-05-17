import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { evolucaoCreateSchema } from '../schemas/evolucao.schemas.js';

// PR #13 (audit 2.23) — URLs de fotos restritas ao bucket S3 do app.

const BUCKET_OK = 'https://apex-test-bucket.s3.sa-east-1.amazonaws.com/evolucao/u1/x.jpg';

describe('evolucaoCreateSchema.fotos — allowlist de URLs', () => {
  it('aceita URLs do bucket configurado', () => {
    assert.doesNotThrow(() =>
      evolucaoCreateSchema.parse({
        fotos: { frente: BUCKET_OK, lado: BUCKET_OK },
      }),
    );
  });

  it('rejeita URL de domínio arbitrário (tracker malicioso)', () => {
    assert.throws(() =>
      evolucaoCreateSchema.parse({
        fotos: { frente: 'https://evil.com/pixel.gif' },
      }),
    );
  });

  it('rejeita HTTP (não-HTTPS) mesmo no bucket', () => {
    assert.throws(() =>
      evolucaoCreateSchema.parse({
        fotos: {
          frente: 'http://apex-test-bucket.s3.sa-east-1.amazonaws.com/x.jpg',
        },
      }),
    );
  });

  it('rejeita bypass de subdomínio (host.evil.com)', () => {
    assert.throws(() =>
      evolucaoCreateSchema.parse({
        fotos: {
          frente:
            'https://apex-test-bucket.s3.sa-east-1.amazonaws.com.evil.com/x.jpg',
        },
      }),
    );
  });

  it('string vazia em frente é tratada como undefined (compat com forms)', () => {
    const out = evolucaoCreateSchema.parse({ fotos: { frente: '' } });
    assert.equal(out.fotos.frente, undefined);
  });

  it('cap de 10 URLs em extras (anti storage abuse)', () => {
    const extras = Array.from({ length: 11 }, () => BUCKET_OK);
    assert.throws(() =>
      evolucaoCreateSchema.parse({ fotos: { extras } }),
    );
  });

  it('aceita exatamente 10 URLs em extras', () => {
    const extras = Array.from({ length: 10 }, () => BUCKET_OK);
    assert.doesNotThrow(() =>
      evolucaoCreateSchema.parse({ fotos: { extras } }),
    );
  });

  it('rejeita extras com 1 URL fora do allowlist no meio', () => {
    const extras = [BUCKET_OK, BUCKET_OK, 'https://evil.com/x.jpg'];
    assert.throws(() =>
      evolucaoCreateSchema.parse({ fotos: { extras } }),
    );
  });
});
