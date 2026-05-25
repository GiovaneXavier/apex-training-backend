-- PR #45 (Sprint 16 — Bloco D) — Audit log unificado + migração de absorção.
--
-- Estratégia (decisão arquitetônica do briefing):
--   1. Cria AuditLog polimórfico (action/entityType/entityId/payload).
--   2. Absorve dados de VinculoAuditLog mantendo rastro histórico.
--   3. DROP TABLE VinculoAuditLog (cleanup — service do PR #44 vai
--      ser refatorado pra usar logAudit() na mesma branch).
--
-- Inverter essa ordem (DROP antes de migrar) PERDE histórico — por isso
-- tudo numa única migration atômica. Postgres garante all-or-nothing.

-- ── 1. Cria a nova tabela ────────────────────────────────────────────
CREATE TABLE "AuditLog" (
  "id"         TEXT         NOT NULL,
  "action"     TEXT         NOT NULL,
  "entityType" TEXT         NOT NULL,
  "entityId"   TEXT         NOT NULL,
  "payload"    JSONB,
  "atorUserId" TEXT         NOT NULL,
  "ip"         TEXT,
  "userAgent"  TEXT,
  "criadoEm"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id"),
  -- FK Restrict no ator: user com audit não pode ser deletado.
  -- Garante integridade do "quem fez" eternamente.
  CONSTRAINT "AuditLog_atorUserId_fkey"
    FOREIGN KEY ("atorUserId") REFERENCES "User"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

-- 4 índices cobrem os filtros previstos do viewer.
-- Custo de manutenção: baixo (inserts são rápidos, pouca contenção).
-- Ganho de leitura: cada filtro vira seek + range scan, não full scan.
CREATE INDEX "AuditLog_criadoEm_idx" ON "AuditLog" ("criadoEm");
CREATE INDEX "AuditLog_atorUserId_criadoEm_idx" ON "AuditLog" ("atorUserId", "criadoEm");
CREATE INDEX "AuditLog_entityType_entityId_criadoEm_idx" ON "AuditLog" ("entityType", "entityId", "criadoEm");
CREATE INDEX "AuditLog_action_criadoEm_idx" ON "AuditLog" ("action", "criadoEm");

-- ── 2. Absorção: VinculoAuditLog → AuditLog ──────────────────────────
-- Transformação:
--   action  = 'vinculo.' || acao  ('vinculo.criar_prof' / 'vinculo.quebrar_prof')
--   entityType = 'Aluno'          (entidade afetada pelo vínculo)
--   entityId   = alunoId
--   payload    = { professorId, motivo }
-- ip/userAgent ficam NULL (não capturávamos antes — backfill impossível).
INSERT INTO "AuditLog" ("id", "action", "entityType", "entityId", "payload", "atorUserId", "criadoEm")
SELECT
  "id",
  'vinculo.' || "acao",
  'Aluno',
  "alunoId",
  jsonb_build_object(
    'professorId', "professorId",
    'motivo', "motivo"
  ),
  "atorUserId",
  "criadoEm"
FROM "VinculoAuditLog";

-- ── 3. Cleanup ───────────────────────────────────────────────────────
-- VinculoAuditLog não tem outras dependências — drop direto.
-- Service vinculoOverride.service.js é refatorado nesta mesma branch
-- pra usar logAudit() em vez de prisma.vinculoAuditLog.create*.
DROP INDEX IF EXISTS "VinculoAuditLog_alunoId_criadoEm_idx";
DROP TABLE "VinculoAuditLog";
