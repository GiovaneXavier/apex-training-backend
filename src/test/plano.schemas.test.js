import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  planoCreateSchema,
  planoUpdateSchema,
  planoListQuery,
} from '../schemas/plano.schemas.js';

const BUCKET_OK = 'https://apex-test-bucket.s3.sa-east-1.amazonaws.com/plano/u1/p.pdf';

describe('planoCreateSchema — validação de input (PR #18b)', () => {
  it('aceita payload mínimo (alunoId + pdfUrl válido)', () => {
    assert.doesNotThrow(() =>
      planoCreateSchema.parse({ alunoId: 'aluno-1', pdfUrl: BUCKET_OK }),
    );
  });

  it('aceita pdfKey + metasText opcionais', () => {
    const out = planoCreateSchema.parse({
      alunoId: 'aluno-1',
      pdfUrl: BUCKET_OK,
      pdfKey: 'plano/u1/p.pdf',
      metasText: 'Foco: hipertrofia',
    });
    assert.equal(out.metasText, 'Foco: hipertrofia');
  });

  it('rejeita pdfUrl fora do allowlist (PR #13)', () => {
    assert.throws(() =>
      planoCreateSchema.parse({
        alunoId: 'aluno-1',
        pdfUrl: 'https://evil.com/p.pdf',
      }),
    );
  });

  it('rejeita pdfUrl HTTP (não-HTTPS)', () => {
    assert.throws(() =>
      planoCreateSchema.parse({
        alunoId: 'aluno-1',
        pdfUrl: 'http://apex-test-bucket.s3.sa-east-1.amazonaws.com/p.pdf',
      }),
    );
  });

  it('rejeita metasText > 2000 chars (anti DoS / storage abuse)', () => {
    assert.throws(() =>
      planoCreateSchema.parse({
        alunoId: 'aluno-1',
        pdfUrl: BUCKET_OK,
        metasText: 'a'.repeat(2001),
      }),
    );
  });

  it('rejeita alunoId vazio', () => {
    assert.throws(() =>
      planoCreateSchema.parse({ alunoId: '', pdfUrl: BUCKET_OK }),
    );
  });
});

describe('planoUpdateSchema — partial sem alunoId', () => {
  it('aceita só metasText', () => {
    assert.doesNotThrow(() => planoUpdateSchema.parse({ metasText: 'novo foco' }));
  });

  it('aceita objeto vazio (no-op)', () => {
    assert.doesNotThrow(() => planoUpdateSchema.parse({}));
  });

  it('rejeita pdfUrl fora do allowlist mesmo em update', () => {
    assert.throws(() =>
      planoUpdateSchema.parse({ pdfUrl: 'https://evil.com/p.pdf' }),
    );
  });

  it('alunoId omitido OK (campo proibido em update)', () => {
    // .omit({ alunoId: true }) — se passar, Zod ignora (strip).
    const out = planoUpdateSchema.parse({ metasText: 'x' });
    assert.equal('alunoId' in out, false);
  });
});

describe('planoListQuery — filtros', () => {
  it('default ativo=true, limit=20', () => {
    const out = planoListQuery.parse({ alunoId: 'aluno-1' });
    assert.equal(out.ativo, 'true');
    assert.equal(out.limit, 20);
  });

  it('aceita ativo=any para histórico completo', () => {
    const out = planoListQuery.parse({ alunoId: 'aluno-1', ativo: 'any' });
    assert.equal(out.ativo, 'any');
  });

  it('rejeita limit > 100 (anti DoS)', () => {
    assert.throws(() =>
      planoListQuery.parse({ alunoId: 'aluno-1', limit: '200' }),
    );
  });
});
