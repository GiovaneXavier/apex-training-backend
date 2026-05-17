import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';

// PR #13 (audit 2.5 + 2.22) — Helmet/CSP nos response headers.
// API JSON usa CSP "default-src 'none'" — qualquer endpoint que
// acidentalmente renderize HTML não pode carregar nada externo.

let app;
before(async () => {
  ({ app } = await import('../index.js'));
});

describe('Helmet/CSP — response headers (PR #13)', () => {
  it('Content-Security-Policy default-src none + frame-ancestors none', async () => {
    const res = await request(app).get('/api/health');
    const csp = res.headers['content-security-policy'];
    assert.ok(csp, 'CSP header presente');
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /form-action 'none'/);
    assert.match(csp, /base-uri 'none'/);
  });

  it('Referrer-Policy = no-referrer', async () => {
    const res = await request(app).get('/api/health');
    assert.equal(res.headers['referrer-policy'], 'no-referrer');
  });

  it('X-Content-Type-Options = nosniff', async () => {
    const res = await request(app).get('/api/health');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
  });

  it('X-Frame-Options = SAMEORIGIN (clickjacking)', async () => {
    const res = await request(app).get('/api/health');
    assert.match(res.headers['x-frame-options'], /SAMEORIGIN|DENY/);
  });

  it('Strict-Transport-Security setado (1 ano + includeSubDomains)', async () => {
    const res = await request(app).get('/api/health');
    const hsts = res.headers['strict-transport-security'];
    assert.ok(hsts, 'HSTS presente');
    assert.match(hsts, /max-age=31536000/);
    assert.match(hsts, /includeSubDomains/i);
  });

  it('Cross-Origin-Resource-Policy = same-site', async () => {
    const res = await request(app).get('/api/health');
    assert.equal(res.headers['cross-origin-resource-policy'], 'same-site');
  });
});
