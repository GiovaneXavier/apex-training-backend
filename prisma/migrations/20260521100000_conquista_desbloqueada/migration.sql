-- PR #31 — Conquistas desbloqueadas (Sprint 11 / Gamificação).
--
-- Catálogo em código; tabela só guarda unlocks por aluno.
-- @@unique([alunoId, codigo]) → idempotência (retry, multi-device).
-- onDelete Cascade → aluno some, conquistas somem junto.

CREATE TABLE "ConquistaDesbloqueada" (
    "id" TEXT NOT NULL,
    "alunoId" TEXT NOT NULL,
    "codigo" TEXT NOT NULL,
    "desbloqueadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "contexto" JSONB,

    CONSTRAINT "ConquistaDesbloqueada_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ConquistaDesbloqueada_alunoId_codigo_key"
  ON "ConquistaDesbloqueada"("alunoId", "codigo");

CREATE INDEX "ConquistaDesbloqueada_alunoId_idx"
  ON "ConquistaDesbloqueada"("alunoId");

ALTER TABLE "ConquistaDesbloqueada"
  ADD CONSTRAINT "ConquistaDesbloqueada_alunoId_fkey"
  FOREIGN KEY ("alunoId") REFERENCES "Aluno"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
