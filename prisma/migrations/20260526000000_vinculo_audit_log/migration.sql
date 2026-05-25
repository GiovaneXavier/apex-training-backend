-- PR #44 (Sprint 16 — Bloco C) — Audit log de overrides de vínculo.
--
-- Registra ações administrativas em VinculoProfessor (criar/quebrar via
-- /api/admin/alunos/:id/vinculo-professor). Tabela intencionalmente
-- desnormalizada — alunoId/professorId ficam como string solta (sem FK)
-- pra preservar rastro mesmo após onDelete:Cascade de Aluno/Professor.

CREATE TABLE "VinculoAuditLog" (
  "id"          TEXT         NOT NULL,
  "acao"        TEXT         NOT NULL,
  "alunoId"     TEXT         NOT NULL,
  "professorId" TEXT,
  "motivo"      TEXT,
  "atorUserId"  TEXT         NOT NULL,
  "criadoEm"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "VinculoAuditLog_pkey" PRIMARY KEY ("id"),
  -- FK só pro ator: garante que toda ação tem dono identificável.
  -- Aluno/Professor ficam como string solta — se forem deletados, o
  -- audit trail sobrevive (essencial pra compliance).
  CONSTRAINT "VinculoAuditLog_atorUserId_fkey"
    FOREIGN KEY ("atorUserId") REFERENCES "User"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

-- Listagem típica: histórico de um aluno específico ordenado por data.
-- Sem o índice composto, vira table scan + sort em N.
CREATE INDEX "VinculoAuditLog_alunoId_criadoEm_idx"
  ON "VinculoAuditLog" ("alunoId", "criadoEm");
