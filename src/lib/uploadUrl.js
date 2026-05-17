// PR #13 (audit 2.23) — allowlist de URLs públicas de mídia.
//
// Antes deste módulo: qualquer string `url()` podia entrar em
// `EvolucaoCorporal.fotos` ou `User.avatarUrl`. Um cliente comprometido
// podia gravar referência a domínio arbitrário — atacante hospeda
// tracker malicioso, vítima abre o app, browser baixa a "foto" e o
// tracker captura IP/UA do prof/nutri que olhar o perfil.
//
// Agora: o schema de evolução e o de avatar só aceitam URLs que batem
// com o bucket S3 configurado (ou seu CDN). Tudo mais → 400.

const ALLOWED_HOSTS = computeAllowedHosts();

function computeAllowedHosts() {
  const hosts = new Set();
  const region = process.env.AWS_REGION;
  const bucket = process.env.S3_BUCKET;
  const cdn = process.env.CDN_BASE_URL;

  if (region && bucket) {
    // Path-style (`s3.<region>.amazonaws.com/<bucket>/`) raramente é
    // usado em uploads novos, mas mantemos a forma virtual-hosted que é
    // o padrão atual da AWS pra buckets criados após 2020.
    hosts.add(`${bucket}.s3.${region}.amazonaws.com`);
    hosts.add(`${bucket}.s3-${region}.amazonaws.com`); // legacy hyphen form
  }
  if (cdn) {
    try {
      hosts.add(new URL(cdn).host);
    } catch {
      // ignora — env.js já validaria, mas defesa em profundidade.
    }
  }
  return hosts;
}

/**
 * Retorna true se `url` é uma string HTTPS e o host está no allowlist.
 * Allowlist é construída do ambiente no boot (S3 bucket configurado e/ou
 * CDN_BASE_URL). Em dev sem S3 configurado, o allowlist fica vazio e a
 * função retorna false para qualquer URL externa — schemas devem ser
 * tolerantes a `optional()` nesse caso.
 */
export function isAllowedAssetUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  return ALLOWED_HOSTS.has(u.host);
}

/**
 * Lista de hosts liberados — exportada para CSP e mensagens de erro.
 */
export function getAllowedAssetHosts() {
  return Array.from(ALLOWED_HOSTS);
}
