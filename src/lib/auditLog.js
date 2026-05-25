// PR #45 (Sprint 16 — Bloco D) — Helper de gravação no AuditLog.
//
// Filosofia (decisões D3 + D4 do briefing):
//   - Helper explícito, chamado pelos services (sem middleware mágico).
//   - Fire-and-forget: helper retorna `void` síncrono; o insert real
//     dispara como Promise sem await. NUNCA bloqueia a request.
//   - Falha de write NÃO propaga — try/catch silencioso + log no Sentry
//     (breadcrumb) + console.warn pra observabilidade local.
//
// Por que catálogo de actions em constante: a tabela é polimórfica
// (action = string livre), mas a sanidade fica no boundary do código.
// Drift cai em PR review, não em produção. Cada ação nova exige PR
// que adicione a chave aqui — fricção saudável pra forçar revisão.

import { prisma } from './prisma.js';
import { captureUnexpectedError } from './sentry.js';

// Catálogo canônico de actions. Use sempre via referência (AUDIT_ACTIONS.X)
// pra evitar typo silencioso. Frontend espelha como string union no TS.
export const AUDIT_ACTIONS = Object.freeze({
  // PR #44 (Bloco C — Vínculos)
  VINCULO_CRIAR_PROF: 'vinculo.criar_prof',
  VINCULO_QUEBRAR_PROF: 'vinculo.quebrar_prof',
  // PR #43 (Bloco B — Users)
  USER_APROVAR: 'user.aprovar',
  USER_ATIVAR: 'user.ativar',
  USER_DESATIVAR: 'user.desativar',
  // Auth
  AUTH_LOGIN: 'auth.login',
  AUTH_LOGIN_FALHOU: 'auth.login_falhou',
  AUTH_LOGOUT: 'auth.logout',
});

// Helper síncrono que dispara write assíncrono sem await.
//
// Assinatura aceita os campos esperados pelo AuditLog. atorUserId pode
// ser null em login_falhou (usuário não autenticado ainda) — neste caso
// usamos um sentinel ou pulamos o write (decisão: pular, já que a FK
// é Restrict).
//
// Uso:
//   logAudit({
//     action: AUDIT_ACTIONS.USER_APROVAR,
//     entityType: 'User',
//     entityId: targetUserId,
//     payload: { roleAlvo: 'PROFESSOR' },
//     atorUserId: req.user.userId,
//     ip: req.ip,
//     userAgent: req.get('user-agent'),
//   });
export function logAudit(entry) {
  // Validação mínima — campos obrigatórios. Sem zod aqui pra evitar
  // overhead em hot path; helper é chamado em tudo.
  if (!entry || typeof entry !== 'object') return;
  const { action, entityType, entityId, atorUserId } = entry;
  if (!action || !entityType || !entityId || !atorUserId) {
    // Faltou campo crítico — log warn e ignora.
    console.warn('[auditLog] entry inválida ignorada', {
      action, entityType, entityId, hasAtor: !!atorUserId,
    });
    return;
  }

  // Fire-and-forget: dispara, não await. Se falhar, captura silencioso.
  prisma.auditLog
    .create({
      data: {
        action,
        entityType,
        entityId: String(entityId),
        payload: entry.payload ?? null,
        atorUserId,
        ip: entry.ip ?? null,
        userAgent: entry.userAgent ?? null,
      },
    })
    .catch((err) => {
      // Audit nunca pode tomar down o app. Apenas observabilidade.
      console.warn('[auditLog] falha ao gravar', action, err?.message || err);
      try {
        captureUnexpectedError(err, { component: 'auditLog', action });
      } catch {
        // captureUnexpectedError pode falhar se Sentry não estiver
        // inicializado. Silêncio absoluto — log já saiu acima.
      }
    });
}

// Helper de teste: aguarda o write completar e devolve o registro.
// Útil em testes node:test pra fazer assertions sobre o conteúdo do log.
// NÃO usar em código de produção.
export async function logAuditAndWait(entry) {
  if (!entry?.action || !entry?.entityType || !entry?.entityId || !entry?.atorUserId) {
    throw new Error('logAuditAndWait: campos obrigatórios faltando');
  }
  return prisma.auditLog.create({
    data: {
      action: entry.action,
      entityType: entry.entityType,
      entityId: String(entry.entityId),
      payload: entry.payload ?? null,
      atorUserId: entry.atorUserId,
      ip: entry.ip ?? null,
      userAgent: entry.userAgent ?? null,
    },
  });
}
