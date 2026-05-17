import { describe, it, before, mock } from 'node:test';
import assert from 'node:assert/strict';

// PR #13 (audit 2.23) — allowlist de URLs públicas de mídia.
//
// Os tests garantem que apenas o bucket S3 configurado e o CDN
// declarado em CDN_BASE_URL passam pelo filtro. Qualquer outro host
// (incluindo subdomínios maliciosos) é rejeitado.

// O módulo lê env no boot — precisamos ter as vars setadas ANTES do
// import. setup-env.js já popula AWS_REGION e S3_BUCKET de teste.
let isAllowedAssetUrl;
let getAllowedAssetHosts;
before(async () => {
  ({ isAllowedAssetUrl, getAllowedAssetHosts } = await import('../lib/uploadUrl.js'));
});

describe('isAllowedAssetUrl — bucket S3 configurado', () => {
  it('aceita URL no bucket configurado (virtual-hosted)', () => {
    assert.equal(
      isAllowedAssetUrl(
        'https://apex-test-bucket.s3.sa-east-1.amazonaws.com/evolucao/u1/foto.jpg',
      ),
      true,
    );
  });

  it('aceita variante legacy com hífen', () => {
    assert.equal(
      isAllowedAssetUrl(
        'https://apex-test-bucket.s3-sa-east-1.amazonaws.com/foto.jpg',
      ),
      true,
    );
  });

  it('rejeita HTTP (não-HTTPS)', () => {
    assert.equal(
      isAllowedAssetUrl(
        'http://apex-test-bucket.s3.sa-east-1.amazonaws.com/foto.jpg',
      ),
      false,
    );
  });

  it('rejeita bucket de OUTRA conta (mesma região)', () => {
    assert.equal(
      isAllowedAssetUrl(
        'https://atacante.s3.sa-east-1.amazonaws.com/foto.jpg',
      ),
      false,
    );
  });

  it('rejeita bucket configurado em OUTRA região', () => {
    assert.equal(
      isAllowedAssetUrl(
        'https://apex-test-bucket.s3.us-east-1.amazonaws.com/foto.jpg',
      ),
      false,
    );
  });

  it('rejeita host arbitrário (tracker)', () => {
    assert.equal(isAllowedAssetUrl('https://evil.com/pixel.gif'), false);
  });

  it('rejeita subdomínio que termina com o host permitido', () => {
    // Anti-bypass clássico: "apex-test-bucket.s3.sa-east-1.amazonaws.com.evil.com"
    assert.equal(
      isAllowedAssetUrl(
        'https://apex-test-bucket.s3.sa-east-1.amazonaws.com.evil.com/foto.jpg',
      ),
      false,
    );
  });

  it('rejeita prefixo no path do bucket alheio (path traversal/confusão)', () => {
    assert.equal(
      isAllowedAssetUrl(
        'https://evil.com/apex-test-bucket.s3.sa-east-1.amazonaws.com/foto.jpg',
      ),
      false,
    );
  });

  it('rejeita string vazia, null, undefined, número', () => {
    assert.equal(isAllowedAssetUrl(''), false);
    assert.equal(isAllowedAssetUrl(null), false);
    assert.equal(isAllowedAssetUrl(undefined), false);
    assert.equal(isAllowedAssetUrl(123), false);
  });

  it('rejeita URL inválida (parse falha)', () => {
    assert.equal(isAllowedAssetUrl('isso não é url'), false);
  });

  it('getAllowedAssetHosts retorna lista não-vazia em test (bucket configurado)', () => {
    const hosts = getAllowedAssetHosts();
    assert.ok(hosts.length >= 1);
    assert.ok(
      hosts.some((h) => h.includes('apex-test-bucket') && h.includes('sa-east-1')),
    );
  });
});
