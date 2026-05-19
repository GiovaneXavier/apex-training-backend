-- PR #32 — Insight semanal do aluno (Sprint 12 / Aluno Intelligence).
-- 1 insight ativo por aluno (@@unique). Cache TTL 7d via expiresAt.
-- result/meta em JSONB. onDelete Cascade: aluno some → insight some.

CREATE TABLE "AlunoInsightSemanal" (
    "id" TEXT NOT NULL,
    "alunoId" TEXT NOT NULL,
    "result" JSONB NOT NULL,
    "meta" JSONB,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AlunoInsightSemanal_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AlunoInsightSemanal_alunoId_key"
  ON "AlunoInsightSemanal"("alunoId");

CREATE INDEX "AlunoInsightSemanal_expiresAt_idx"
  ON "AlunoInsightSemanal"("expiresAt");

ALTER TABLE "AlunoInsightSemanal"
  ADD CONSTRAINT "AlunoInsightSemanal_alunoId_fkey"
  FOREIGN KEY ("alunoId") REFERENCES "Aluno"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
