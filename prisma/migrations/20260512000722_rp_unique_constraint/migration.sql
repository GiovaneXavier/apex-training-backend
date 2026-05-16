-- PR #10 — RP unique constraint para fechar a race condition de
-- salvarExecucao (audit 1.10 + 3.8).
--
-- Antes desta migration, dois POSTs concorrentes no mesmo treino com a
-- mesma série podiam criar 2 RPs idênticos: ambos viam "não há RP" no
-- findFirst e ambos passavam pro create. Com a fila offline drenando em
-- sequência rápida (PR #9 useOfflineSync), a janela ficou bem maior.

-- Step 1: Dedupe defensivo. Em DBs com dados pré-PR #10 pode haver linhas
-- duplicadas que viola a constraint nova. Estratégia: manter o maior
-- valor por combinação; em empate de valor, manter o mais recente; em
-- empate de tudo, manter o maior id (estável e determinístico).
-- Subquery FROM evita "auto-reference" issues no DELETE em Postgres.
DELETE FROM "RecordePessoal" rp
USING (
  SELECT id
  FROM "RecordePessoal"
  WHERE id NOT IN (
    SELECT DISTINCT ON ("alunoId", exercicio, metrica, COALESCE(reps, -1)) id
    FROM "RecordePessoal"
    ORDER BY "alunoId", exercicio, metrica, COALESCE(reps, -1),
             valor DESC, "dataRecorde" DESC, id DESC
  )
) dup
WHERE rp.id = dup.id;

-- Step 2: a constraint propriamente dita.
-- NULLs em "reps" são tratados como distintos pelo Postgres (default
-- ANSI). Para modalidades sem reps (corrida/ciclismo), o discriminador
-- continua sendo o exercicio ("5K", "10K", etc) — não há race real ali.
CREATE UNIQUE INDEX "RecordePessoal_alunoId_exercicio_metrica_reps_key"
  ON "RecordePessoal"("alunoId", "exercicio", "metrica", "reps");
