-- CreateEnum
CREATE TYPE "AvaliadorTipo" AS ENUM ('ALUNO', 'NUTRICIONISTA', 'PROFESSOR');

-- CreateTable
CREATE TABLE "EvolucaoCorporal" (
    "id" TEXT NOT NULL,
    "alunoId" TEXT NOT NULL,
    "avaliadorId" TEXT,
    "avaliadorTipo" "AvaliadorTipo" NOT NULL,
    "dataAvaliacao" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "pesoKg" DOUBLE PRECISION,
    "alturaCm" INTEGER,
    "imc" DOUBLE PRECISION,
    "percentualGordura" DOUBLE PRECISION,
    "protocolo" TEXT,
    "medidas" JSONB,
    "fotos" JSONB,
    "observacoes" TEXT,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizadoEm" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EvolucaoCorporal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EvolucaoCorporal_alunoId_dataAvaliacao_idx" ON "EvolucaoCorporal"("alunoId", "dataAvaliacao");

-- CreateIndex
CREATE INDEX "EvolucaoCorporal_avaliadorTipo_idx" ON "EvolucaoCorporal"("avaliadorTipo");

-- AddForeignKey
ALTER TABLE "EvolucaoCorporal" ADD CONSTRAINT "EvolucaoCorporal_alunoId_fkey" FOREIGN KEY ("alunoId") REFERENCES "Aluno"("id") ON DELETE CASCADE ON UPDATE CASCADE;

