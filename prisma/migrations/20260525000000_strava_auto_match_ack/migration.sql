-- PR #41c — ACK de auto-match Tier 1.
-- Tier 1 vincula via webhook sem o aluno saber. Frontend lê esse flag
-- pra disparar toast "X autopreenchidos — Desfazer" no Dashboard, então
-- bate POST /treinos/strava-ack pra marcar como visto.
--
-- DEFAULT TRUE: registros pré-migração (Tier 2 manual + treinos sem
-- vínculo) NÃO devem disparar toast retroativo. Tier 1 novo grava
-- explicitamente FALSE no service.

ALTER TABLE "Treino"
  ADD COLUMN "stravaAutoMatchAck" BOOLEAN NOT NULL DEFAULT true;

-- Índice parcial pra acelerar o filtro do Dashboard:
--   WHERE alunoId = ? AND stravaAutoMatchAck = false
-- Cardinalidade esperada baixíssima (poucos auto-matches não-vistos por
-- aluno a qualquer momento) → partial index é a forma certa.
CREATE INDEX "Treino_aluno_autoMatchAck_idx"
  ON "Treino" ("alunoId")
  WHERE "stravaAutoMatchAck" = false;
