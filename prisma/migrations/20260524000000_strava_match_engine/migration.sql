-- PR #41b — Motor de match Strava ↔ Treino prescrito.
-- Adiciona vínculo no Treino + tabelas de cooldown (MatchRejeitado) e
-- sugestões Tier 2 retidas (StravaSugestao).

-- 1. Coluna nova em Treino (vínculo opcional com atividade Strava).
ALTER TABLE "Treino"
  ADD COLUMN "stravaActivityId" TEXT;

-- UNIQUE: uma atividade Strava só pode estar vinculada a um único treino.
-- NULL é distinto por default no Postgres — múltiplos treinos sem vínculo OK.
CREATE UNIQUE INDEX "Treino_stravaActivityId_key"
  ON "Treino" ("stravaActivityId");

-- 2. MatchRejeitado — cooldown anti-resugerir.
CREATE TABLE "MatchRejeitado" (
  "id"               TEXT         NOT NULL,
  "alunoId"          TEXT         NOT NULL,
  "treinoId"         TEXT         NOT NULL,
  "stravaActivityId" TEXT         NOT NULL,
  "motivo"           TEXT         NOT NULL,
  "scoreNaRecusa"    DOUBLE PRECISION,
  "criadoEm"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "MatchRejeitado_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MatchRejeitado_alunoId_fkey"
    FOREIGN KEY ("alunoId")  REFERENCES "Aluno"("id")  ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "MatchRejeitado_treinoId_fkey"
    FOREIGN KEY ("treinoId") REFERENCES "Treino"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "MatchRejeitado_treinoId_stravaActivityId_key"
  ON "MatchRejeitado" ("treinoId", "stravaActivityId");

CREATE INDEX "MatchRejeitado_alunoId_criadoEm_idx"
  ON "MatchRejeitado" ("alunoId", "criadoEm");

CREATE INDEX "MatchRejeitado_stravaActivityId_idx"
  ON "MatchRejeitado" ("stravaActivityId");

-- 3. StravaSugestao — Tier 2 retido aguardando opt-in do aluno.
CREATE TABLE "StravaSugestao" (
  "id"                TEXT         NOT NULL,
  "alunoId"           TEXT         NOT NULL,
  "treinoId"          TEXT         NOT NULL,
  "atividadeStravaId" TEXT         NOT NULL,
  "score"             DOUBLE PRECISION NOT NULL,
  "scoreBreakdown"    JSONB        NOT NULL,
  "status"            TEXT         NOT NULL DEFAULT 'PENDENTE',
  "criadaEm"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvidaEm"       TIMESTAMP(3),

  CONSTRAINT "StravaSugestao_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "StravaSugestao_alunoId_fkey"
    FOREIGN KEY ("alunoId")           REFERENCES "Aluno"("id")           ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "StravaSugestao_treinoId_fkey"
    FOREIGN KEY ("treinoId")          REFERENCES "Treino"("id")          ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "StravaSugestao_atividadeStravaId_fkey"
    FOREIGN KEY ("atividadeStravaId") REFERENCES "AtividadeStrava"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- 1 atividade Strava → no máximo 1 sugestão ativa por vez.
-- (status=ACEITA/REJEITADA não bloqueia novas, mas atividadeStravaId vira
--  ponto único — se aluno rejeita e webhook re-dispara, MatchRejeitado
--  intercepta antes de tentar criar sugestão de novo).
CREATE UNIQUE INDEX "StravaSugestao_atividadeStravaId_key"
  ON "StravaSugestao" ("atividadeStravaId");

CREATE INDEX "StravaSugestao_alunoId_status_criadaEm_idx"
  ON "StravaSugestao" ("alunoId", "status", "criadaEm");

CREATE INDEX "StravaSugestao_treinoId_idx"
  ON "StravaSugestao" ("treinoId");
