import { describe, it, before, mock } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import jwt from 'jsonwebtoken';

// Mock dos módulos AWS SDK ANTES de importar o app.
// `mock.module()` é estável em Node 22.3+, fica até o fim do processo.
// Com isto evitamos qualquer hit em S3 real durante CI.
//
// PR #13 — captura o último PutObjectCommand pra inspecionar SSE,
// ContentType e ContentLength assinados.
export const captured = { lastCommand: null };
mock.module('@aws-sdk/client-s3', {
  namedExports: {
    S3Client: class {},
    PutObjectCommand: class {
      constructor(input) {
        this.input = input;
        captured.lastCommand = this;
      }
    },
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
    { sub: 'user-test-1', role: 'ALUNO' },
    process.env.JWT_SECRET,
    { expiresIn: '1h' },
  );
  authHeader = `Bearer ${token}`;
});

describe('GET /api/upload/presigned-url', () => {
  it('401 sem token', async () => {
    const res = await request(app)
      .get('/api/upload/presigned-url')
      .query({ contentType: 'image/jpeg', contentLength: 1024 });
    assert.equal(res.status, 401);
  });

  it('400 quando contentType não é imagem suportada', async () => {
    const res = await request(app)
      .get('/api/upload/presigned-url')
      .set('Authorization', authHeader)
      .query({ contentType: 'application/pdf', contentLength: 1024 });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'ValidationError');
  });

  it('400 quando contentLength excede 8MB', async () => {
    const res = await request(app)
      .get('/api/upload/presigned-url')
      .set('Authorization', authHeader)
      .query({
        contentType: 'image/jpeg',
        contentLength: 9 * 1024 * 1024,
      });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'ValidationError');
  });

  it('400 quando contentLength é zero ou negativo', async () => {
    const res = await request(app)
      .get('/api/upload/presigned-url')
      .set('Authorization', authHeader)
      .query({ contentType: 'image/png', contentLength: 0 });
    assert.equal(res.status, 400);
  });

  it('200 com URL pré-assinada quando dados são válidos', async () => {
    const res = await request(app)
      .get('/api/upload/presigned-url')
      .set('Authorization', authHeader)
      .query({
        contentType: 'image/jpeg',
        contentLength: 500_000,
        kind: 'evolucao',
      });
    assert.equal(res.status, 200);
    assert.match(res.body.uploadUrl, /mock-signed-url/);
    assert.ok(res.body.publicUrl);
    assert.match(res.body.key, /^evolucao\/user-test-1\/[0-9a-f-]+\.jpg$/);
    assert.equal(res.body.requiredHeaders['Content-Type'], 'image/jpeg');
    assert.equal(res.body.expiresIn, 300);
  });

  it('aceita kind=avatar', async () => {
    const res = await request(app)
      .get('/api/upload/presigned-url')
      .set('Authorization', authHeader)
      .query({
        contentType: 'image/webp',
        contentLength: 100_000,
        kind: 'avatar',
      });
    assert.equal(res.status, 200);
    assert.match(res.body.key, /^avatar\/user-test-1\//);
  });

  // PR #13 (audit 2.16) — defesa em profundidade no presigned URL.
  describe('S3 PutObjectCommand hardening', () => {
    it('inclui ServerSideEncryption: AES256 (assinado no presigned)', async () => {
      await request(app)
        .get('/api/upload/presigned-url')
        .set('Authorization', authHeader)
        .query({ contentType: 'image/jpeg', contentLength: 1000 });
      assert.equal(captured.lastCommand.input.ServerSideEncryption, 'AES256');
    });

    it('inclui ContentType assinado (trava MIME — não dá pra subir .iso)', async () => {
      await request(app)
        .get('/api/upload/presigned-url')
        .set('Authorization', authHeader)
        .query({ contentType: 'image/png', contentLength: 2000 });
      assert.equal(captured.lastCommand.input.ContentType, 'image/png');
    });

    it('inclui ContentLength EXATO assinado (trava tamanho — não vira 10GB)', async () => {
      await request(app)
        .get('/api/upload/presigned-url')
        .set('Authorization', authHeader)
        .query({ contentType: 'image/jpeg', contentLength: 1_234_567 });
      assert.equal(captured.lastCommand.input.ContentLength, 1_234_567);
    });

    it('Metadata carrega userId+kind pra audit trail', async () => {
      await request(app)
        .get('/api/upload/presigned-url')
        .set('Authorization', authHeader)
        .query({ contentType: 'image/jpeg', contentLength: 5000, kind: 'avatar' });
      assert.equal(captured.lastCommand.input.Metadata.userId, 'user-test-1');
      assert.equal(captured.lastCommand.input.Metadata.kind, 'avatar');
    });
  });
});
