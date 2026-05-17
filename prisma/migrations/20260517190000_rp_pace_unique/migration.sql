-- PR #19 — Sala de Troféus Endurance: unique parcial pra RPs de pace.
--
-- Problema:
--   O unique composto criado no PR #10 é (alunoId, exercicio, metrica, reps).
--   Postgres trata NULL como distinto em UNIQUE: dois RPs de pace
--   (reps=NULL) pra mesmo aluno+exercicio passariam batido. Pra
--   musculação isso é OK (cada combo de reps é único), mas pra
--   endurance precisamos de exclusividade real.
--
-- Solução:
--   Unique índice PARCIAL que cobre EXATAMENTE as linhas com reps=NULL.
--   Não conflita com o índice composto existente — atua só onde aquele
--   falha. Prisma não emite WHERE em unique nativo (limitação histórica
--   do migrate engine), por isso este SQL é raw e o schema mantém só
--   um comentário explicativo.
--
-- Efeito:
--   - Insert duplicado em (alunoId, exercicio, metrica) com reps=NULL
--     gera P2002 → service captura e cai no caminho de UPDATE (lower-
--     is-better via predicado `valor > novo_pace`).

CREATE UNIQUE INDEX "RecordePessoal_pace_unq"
  ON "RecordePessoal" ("alunoId", "exercicio", "metrica")
  WHERE reps IS NULL;
