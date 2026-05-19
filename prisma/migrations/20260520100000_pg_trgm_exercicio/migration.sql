-- PR #30 — pg_trgm extension + GIN index pra Exercicio.nome.
--
-- Habilita similaridade de strings via trigrama (1-3 caracteres). Usado
-- pelo AI Plan Drafting pra reconciliar nomes livres do LLM
-- ("Supino Inclinado com Halteres") com o catálogo canônico.
--
-- Operadores fornecidos pelo pg_trgm:
--   similarity(a, b) → float 0..1
--   a %  b           → "similar to" (índice GIN ativa quando o operador é usado)
--   a <-> b          → distância (1 - similarity)
--
-- Requer privilégio CREATE na database. Neon dá isso por default na
-- role owner; em ambientes managed restritos, rodar como superuser.
-- IF NOT EXISTS em ambos torna a migration idempotente — re-run safe.
--
-- Índice GIN gin_trgm_ops é o que viabiliza similarity() rápida em
-- catálogo grande. Sem ele, similarity() faz seq scan no Exercicio
-- inteiro a cada query — degradação linear com tamanho do catálogo.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "Exercicio_nome_trgm_idx"
  ON "Exercicio"
  USING gin (nome gin_trgm_ops);
