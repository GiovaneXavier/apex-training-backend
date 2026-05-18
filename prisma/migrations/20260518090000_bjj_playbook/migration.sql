-- PR #22 — BJJ Playbook: modalidade JIU_JITSU + catálogo estendido.
--
-- Estende a infraestrutura existente sem quebrar consumidores:
--   - Modalidade ganha JIU_JITSU (PERTO de HYROX, antes de OUTRO).
--   - Exercicio ganha dominio (default MUSCULACAO — backfill implícito),
--     posicao (texto livre p/ BJJ), tipoMovimento (enum opcional).
--   - Índices p/ filtros do picker (dominio, dominio+tipoMovimento).

-- AlterEnum: Modalidade ganha JIU_JITSU.
ALTER TYPE "Modalidade" ADD VALUE 'JIU_JITSU';

-- CreateEnum: domínio do exercício.
CREATE TYPE "DominioExercicio" AS ENUM ('MUSCULACAO', 'JIU_JITSU', 'MOBILIDADE', 'OUTRO');

-- CreateEnum: tipo de movimento (granularidade do BJJ).
CREATE TYPE "TipoMovimento" AS ENUM (
  'DRILL', 'PASSAGEM', 'GUARDA', 'RASPAGEM', 'SUBMISSAO', 'ENTRADA', 'SAIDA'
);

-- AlterTable: Exercicio ganha 3 colunas novas.
-- `dominio` com default MUSCULACAO preenche linhas existentes automaticamente —
-- catálogo histórico fica visível na aba MUSCULACAO sem backfill manual.
ALTER TABLE "Exercicio"
  ADD COLUMN "dominio" "DominioExercicio" NOT NULL DEFAULT 'MUSCULACAO',
  ADD COLUMN "posicao" TEXT,
  ADD COLUMN "tipoMovimento" "TipoMovimento";

-- Índices: o picker da UI filtra por (dominio) e às vezes por
-- (dominio, tipoMovimento) — composto cobre ambas.
CREATE INDEX "Exercicio_dominio_idx" ON "Exercicio"("dominio");
CREATE INDEX "Exercicio_dominio_tipoMovimento_idx" ON "Exercicio"("dominio", "tipoMovimento");
