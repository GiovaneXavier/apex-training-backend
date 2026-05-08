import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';

let app;
before(async () => {
  ({ app } = await import('../index.js'));
});

describe('GET /api/health', () => {
  it('200 e payload de saúde', async () => {
    const res = await request(app).get('/api/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ok');
    assert.equal(res.body.service, 'apex-training-backend');
  });

  it('404 em rota desconhecida', async () => {
    const res = await request(app).get('/api/nope');
    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'NotFound');
  });
});
