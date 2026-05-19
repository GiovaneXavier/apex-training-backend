-- PR #28 — Coach Briefing Semanal.
-- 1 briefing ativo por Professor; refresh força regeneração via upsert.
-- result JSONB carrega payload validado do LLM (síntese + alunos em alerta).
-- meta JSONB carrega telemetria (alunos considerados, modelo, tokens).
-- onDelete CASCADE: professor deletado → briefing some.

-- CreateTable
CREATE TABLE "CoachBriefing" (
    "id" TEXT NOT NULL,
    "professorId" TEXT NOT NULL,
    "result" JSONB NOT NULL,
    "meta" JSONB,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CoachBriefing_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CoachBriefing_professorId_key" ON "CoachBriefing"("professorId");

-- CreateIndex
CREATE INDEX "CoachBriefing_expiresAt_idx" ON "CoachBriefing"("expiresAt");

-- AddForeignKey
ALTER TABLE "CoachBriefing"
  ADD CONSTRAINT "CoachBriefing_professorId_fkey"
  FOREIGN KEY ("professorId") REFERENCES "Professor"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
