-- PR #37 (Sprint 14) — Macro-ciclo do atleta.
-- Race A/B/C + invariante "1 Race A ativa por aluno" via partial unique index.

-- 1. Enum novo
CREATE TYPE "ProvaPrioridade" AS ENUM ('A', 'B', 'C');

-- 2. Colunas
ALTER TABLE "Prova"
  ADD COLUMN     "prioridade"   "ProvaPrioridade" NOT NULL DEFAULT 'C',
  ADD COLUMN     "arquivada"    BOOLEAN           NOT NULL DEFAULT false,
  ADD COLUMN     "alvoTempo"    TEXT,
  ADD COLUMN     "local"        TEXT,
  ADD COLUMN     "atualizadoEm" TIMESTAMP(3)      NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- 3. Invariante de negócio: 1 Race A ativa por aluno.
-- Partial unique — só aplica para linhas com prioridade='A' AND arquivada=false.
-- Sem funções voláteis (now()/CURRENT_DATE) porque Postgres rejeita em
-- expressões de índice. Estado controlado por boolean determinístico.
CREATE UNIQUE INDEX "prova_alvo_principal_ativo"
  ON "Prova" ("alunoId")
  WHERE "prioridade" = 'A' AND "arquivada" = false;

-- 4. Índice secundário pra dashboard query frequente.
-- "Qual a Race A ativa do aluno X?" + "Quais provas do aluno X?".
CREATE INDEX "Prova_alunoId_prioridade_arquivada_idx"
  ON "Prova" ("alunoId", "prioridade", "arquivada");
