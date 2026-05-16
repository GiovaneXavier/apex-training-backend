-- Índice GIN para containment queries em Treino.detalhes (jsonb).
-- Usa jsonb_path_ops (mais compacto, suporta `@>` que é o operador que vamos
-- usar em historicoCargas — não precisa dos outros operadores GIN como `?` ou `?&`).
-- Custo: ~20-30% do tamanho dos dados em disco, mas reduz historicoCargas
-- de table scan (60+ linhas inteiras) para index seek + bitmap heap fetch.
CREATE INDEX "Treino_detalhes_gin_idx" ON "Treino" USING GIN ("detalhes" jsonb_path_ops);
