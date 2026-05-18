-- PR #24 — Jornada do Faixa Preta (BJJ).
-- Cria enum Faixa + tabela EvolucaoMarcial com índice composto pra
-- consulta "faixa atual" instantânea.

-- CreateEnum
CREATE TYPE "Faixa" AS ENUM (
  'BRANCA', 'AZUL', 'ROXA', 'MARROM', 'PRETA', 'CORAL', 'VERMELHA'
);

-- CreateTable
CREATE TABLE "EvolucaoMarcial" (
    "id" TEXT NOT NULL,
    "alunoId" TEXT NOT NULL,
    "faixa" "Faixa" NOT NULL,
    "grauNum" INTEGER NOT NULL DEFAULT 0,
    "dataPromocao" TIMESTAMP(3) NOT NULL,
    "instrutorNome" TEXT,
    "observacao" TEXT,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvolucaoMarcial_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- "Faixa atual do atleta" filtra por alunoId + ordena por
-- dataPromocao DESC LIMIT 1. Índice composto cobre direto.
CREATE INDEX "EvolucaoMarcial_alunoId_dataPromocao_idx"
  ON "EvolucaoMarcial"("alunoId", "dataPromocao");

-- AddForeignKey
ALTER TABLE "EvolucaoMarcial" ADD CONSTRAINT "EvolucaoMarcial_alunoId_fkey"
  FOREIGN KEY ("alunoId") REFERENCES "Aluno"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
