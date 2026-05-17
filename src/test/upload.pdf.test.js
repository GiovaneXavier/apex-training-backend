import { describe, it, before, mock } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import jwt from 'jsonwebtoken';

// PR #18b — upload presign agora aceita `kind=plano-alimentar` com
// MIME application/pdf e cap de 15MB. Os outros kinds continuam só
// aceitando imagens.

mock.module('@aws-sdk/client-s3', {
  namedExports: {
    S3Client: class {},
    PutObjectCommand: class { constructor(input) { this.input = input; } },
  },
});
mock.module('@aws-sdk/s3-request-presigner', {
  namedExports: {
    getSignedUrl: async () =>
      'https://apex-test-bucket.s3.sa-east-1.amazonaws.com/mock-signed-url',
  },
});

let app;
let authHeader;
before(async () => {
  ({ app } = await import('../index.js'));
  const token = jwt.sign(
    { sub: 'user-nutri-1', role: 'NUTRICIONISTA' },
    process.env.JWT_SECRET,
    { expiresIn: '1h' },
  );
  authHeader = `Bearer ${token}`;
});

describe('GET /api/upload/presigned-url — kind=plano-alimentar', () => {
  it('aceita application/pdf no kind plano-alimentar', async () => {
    const res = await request(app)
      .get('/api/upload/presigned-url')
      .set('Authorization', authHeader)
      .query({
        contentType: 'application/pdf',
        contentLength: 1_000_000,
        kind: 'plano-alimentar',
      });
    assert.equal(res.status, 200);
    assert.match(res.body.key, /^plano-alimentar\/user-nutri-1\/[0-9a-f-]+\.pdf$/);
    assert.equal(res.body.requiredHeaders['Content-Type'], 'application/pdf');
  });

  it('rejeita image/jpeg no kind plano-alimentar (mismatch)', async () => {
    const res = await request(app)
      .get('/api/upload/presigned-url')
      .set('Authorization', authHeader)
      .query({
        contentType: 'image/jpeg',
        contentLength: 1000,
        kind: 'plano-alimentar',
      });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'ValidationError');
  });

  it('aceita PDF até 15MB', async () => {
    const res = await request(app)
      .get('/api/upload/presigned-url')
      .set('Authorization', authHeader)
      .query({
        contentType: 'application/pdf',
        contentLength: 15 * 1024 * 1024,
        kind: 'plano-alimentar',
      });
    assert.equal(res.status, 200);
  });

  it('rejeita PDF > 15MB (anti-DoS)', async () => {
    const res = await request(app)
      .get('/api/upload/presigned-url')
      .set('Authorization', authHeader)
      .query({
        contentType: 'application/pdf',
        contentLength: 16 * 1024 * 1024,
        kind: 'plano-alimentar',
      });
    assert.equal(res.status, 400);
  });

  it('rejeita application/pdf no kind evolucao (cross-kind block)', async () => {
    const res = await request(app)
      .get('/api/upload/presigned-url')
      .set('Authorization', authHeader)
      .query({
        contentType: 'application/pdf',
        contentLength: 1000,
        kind: 'evolucao',
      });
    assert.equal(res.status, 400);
  });
});
