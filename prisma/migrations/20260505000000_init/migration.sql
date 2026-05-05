-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ALUNO', 'PROFESSOR', 'NUTRICIONISTA');

-- CreateEnum
CREATE TYPE "Modalidade" AS ENUM ('MUSCULACAO', 'CORRIDA', 'CICLISMO', 'NATACAO', 'TRIATHLON', 'OUTRO');

-- CreateEnum
CREATE TYPE "StatusTreino" AS ENUM ('PENDENTE', 'EM_EXECUCAO', 'CONCLUIDO', 'PULADO');

-- CreateEnum
CREATE TYPE "DiaSemana" AS ENUM ('DOM', 'SEG', 'TER', 'QUA', 'QUI', 'SEX', 'SAB');

-- CreateEnum
CREATE TYPE "GrupoMuscular" AS ENUM ('PEITO', 'COSTAS', 'OMBRO', 'BICEPS', 'TRICEPS', 'ANTEBRACO', 'ABDOMEN', 'GLUTEO', 'QUADRICEPS', 'POSTERIOR', 'PANTURRILHA', 'CARDIO', 'CORE', 'OUTRO');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "senhaHash" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "avatarUrl" TEXT,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizadoEm" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Aluno" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "dataNascimento" TIMESTAMP(3),
    "pesoKg" DOUBLE PRECISION,
    "alturaCm" INTEGER,
    "stravaUserId" TEXT,
    "stravaToken" TEXT,
    "stravaRefresh" TEXT,
    "stravaExpiresAt" TIMESTAMP(3),

    CONSTRAINT "Aluno_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Professor" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "bio" TEXT,

    CONSTRAINT "Professor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Nutricionista" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "crn" TEXT,

    CONSTRAINT "Nutricionista_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VinculoProfessor" (
    "id" TEXT NOT NULL,
    "alunoId" TEXT NOT NULL,
    "professorId" TEXT NOT NULL,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VinculoProfessor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VinculoNutricionista" (
    "id" TEXT NOT NULL,
    "alunoId" TEXT NOT NULL,
    "nutricionistaId" TEXT NOT NULL,
    "aceitoPeloAluno" BOOLEAN NOT NULL DEFAULT false,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VinculoNutricionista_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Treino" (
    "id" TEXT NOT NULL,
    "alunoId" TEXT NOT NULL,
    "professorId" TEXT,
    "rotinaId" TEXT,
    "modalidade" "Modalidade" NOT NULL,
    "titulo" TEXT NOT NULL,
    "dataAlvo" TIMESTAMP(3) NOT NULL,
    "status" "StatusTreino" NOT NULL DEFAULT 'PENDENTE',
    "detalhes" JSONB NOT NULL,
    "iniciadoEm" TIMESTAMP(3),
    "finalizadoEm" TIMESTAMP(3),
    "reagendadoDe" TIMESTAMP(3),
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizadoEm" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Treino_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Prova" (
    "id" TEXT NOT NULL,
    "alunoId" TEXT NOT NULL,
    "modalidade" "Modalidade" NOT NULL,
    "nome" TEXT NOT NULL,
    "data" TIMESTAMP(3) NOT NULL,
    "detalhes" JSONB NOT NULL,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Prova_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecordePessoal" (
    "id" TEXT NOT NULL,
    "alunoId" TEXT NOT NULL,
    "modalidade" "Modalidade" NOT NULL,
    "exercicio" TEXT NOT NULL,
    "metrica" TEXT NOT NULL,
    "valor" DOUBLE PRECISION NOT NULL,
    "unidade" TEXT NOT NULL,
    "reps" INTEGER,
    "dataRecorde" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "treinoId" TEXT,

    CONSTRAINT "RecordePessoal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AtividadeStrava" (
    "id" TEXT NOT NULL,
    "alunoId" TEXT NOT NULL,
    "stravaId" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "distanciaM" DOUBLE PRECISION NOT NULL,
    "duracaoSeg" INTEGER NOT NULL,
    "ritmoMedio" DOUBLE PRECISION,
    "fcMedia" INTEGER,
    "iniciadoEm" TIMESTAMP(3) NOT NULL,
    "payloadRaw" JSONB NOT NULL,
    "sincronizadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AtividadeStrava_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Exercicio" (
    "id" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "videoUrl" TEXT,
    "imagemUrl" TEXT,
    "grupoMuscular" "GrupoMuscular",
    "equipamento" TEXT,
    "instrucoes" TEXT,
    "criadoPorId" TEXT,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizadoEm" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Exercicio_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RotinaMusculacao" (
    "id" TEXT NOT NULL,
    "alunoId" TEXT NOT NULL,
    "professorId" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "diaSemana" "DiaSemana" NOT NULL,
    "vigenciaInicio" TIMESTAMP(3) NOT NULL,
    "vigenciaFim" TIMESTAMP(3),
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizadoEm" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RotinaMusculacao_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RotinaExercicio" (
    "id" TEXT NOT NULL,
    "rotinaId" TEXT NOT NULL,
    "exercicioId" TEXT NOT NULL,
    "ordem" INTEGER NOT NULL,
    "series" INTEGER NOT NULL,
    "reps" INTEGER,
    "repsMin" INTEGER,
    "repsMax" INTEGER,
    "cargaPctRP" DOUBLE PRECISION,
    "cargaKg" DOUBLE PRECISION,
    "descansoSeg" INTEGER,
    "observacao" TEXT,

    CONSTRAINT "RotinaExercicio_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_role_idx" ON "User"("role");

-- CreateIndex
CREATE UNIQUE INDEX "Aluno_userId_key" ON "Aluno"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Aluno_stravaUserId_key" ON "Aluno"("stravaUserId");

-- CreateIndex
CREATE UNIQUE INDEX "Professor_userId_key" ON "Professor"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Nutricionista_userId_key" ON "Nutricionista"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "VinculoProfessor_alunoId_professorId_key" ON "VinculoProfessor"("alunoId", "professorId");

-- CreateIndex
CREATE UNIQUE INDEX "VinculoNutricionista_alunoId_nutricionistaId_key" ON "VinculoNutricionista"("alunoId", "nutricionistaId");

-- CreateIndex
CREATE INDEX "Treino_alunoId_dataAlvo_idx" ON "Treino"("alunoId", "dataAlvo");

-- CreateIndex
CREATE INDEX "Treino_status_idx" ON "Treino"("status");

-- CreateIndex
CREATE INDEX "Prova_alunoId_data_idx" ON "Prova"("alunoId", "data");

-- CreateIndex
CREATE INDEX "RecordePessoal_alunoId_exercicio_idx" ON "RecordePessoal"("alunoId", "exercicio");

-- CreateIndex
CREATE UNIQUE INDEX "AtividadeStrava_stravaId_key" ON "AtividadeStrava"("stravaId");

-- CreateIndex
CREATE INDEX "AtividadeStrava_alunoId_iniciadoEm_idx" ON "AtividadeStrava"("alunoId", "iniciadoEm");

-- CreateIndex
CREATE UNIQUE INDEX "Exercicio_nome_key" ON "Exercicio"("nome");

-- CreateIndex
CREATE INDEX "Exercicio_grupoMuscular_idx" ON "Exercicio"("grupoMuscular");

-- CreateIndex
CREATE INDEX "RotinaMusculacao_alunoId_diaSemana_idx" ON "RotinaMusculacao"("alunoId", "diaSemana");

-- CreateIndex
CREATE INDEX "RotinaMusculacao_alunoId_vigenciaInicio_vigenciaFim_idx" ON "RotinaMusculacao"("alunoId", "vigenciaInicio", "vigenciaFim");

-- CreateIndex
CREATE INDEX "RotinaExercicio_rotinaId_idx" ON "RotinaExercicio"("rotinaId");

-- CreateIndex
CREATE UNIQUE INDEX "RotinaExercicio_rotinaId_ordem_key" ON "RotinaExercicio"("rotinaId", "ordem");

-- AddForeignKey
ALTER TABLE "Aluno" ADD CONSTRAINT "Aluno_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Professor" ADD CONSTRAINT "Professor_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Nutricionista" ADD CONSTRAINT "Nutricionista_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VinculoProfessor" ADD CONSTRAINT "VinculoProfessor_alunoId_fkey" FOREIGN KEY ("alunoId") REFERENCES "Aluno"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VinculoProfessor" ADD CONSTRAINT "VinculoProfessor_professorId_fkey" FOREIGN KEY ("professorId") REFERENCES "Professor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VinculoNutricionista" ADD CONSTRAINT "VinculoNutricionista_alunoId_fkey" FOREIGN KEY ("alunoId") REFERENCES "Aluno"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VinculoNutricionista" ADD CONSTRAINT "VinculoNutricionista_nutricionistaId_fkey" FOREIGN KEY ("nutricionistaId") REFERENCES "Nutricionista"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Treino" ADD CONSTRAINT "Treino_alunoId_fkey" FOREIGN KEY ("alunoId") REFERENCES "Aluno"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Treino" ADD CONSTRAINT "Treino_professorId_fkey" FOREIGN KEY ("professorId") REFERENCES "Professor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Treino" ADD CONSTRAINT "Treino_rotinaId_fkey" FOREIGN KEY ("rotinaId") REFERENCES "RotinaMusculacao"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Prova" ADD CONSTRAINT "Prova_alunoId_fkey" FOREIGN KEY ("alunoId") REFERENCES "Aluno"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecordePessoal" ADD CONSTRAINT "RecordePessoal_alunoId_fkey" FOREIGN KEY ("alunoId") REFERENCES "Aluno"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AtividadeStrava" ADD CONSTRAINT "AtividadeStrava_alunoId_fkey" FOREIGN KEY ("alunoId") REFERENCES "Aluno"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RotinaMusculacao" ADD CONSTRAINT "RotinaMusculacao_alunoId_fkey" FOREIGN KEY ("alunoId") REFERENCES "Aluno"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RotinaMusculacao" ADD CONSTRAINT "RotinaMusculacao_professorId_fkey" FOREIGN KEY ("professorId") REFERENCES "Professor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RotinaExercicio" ADD CONSTRAINT "RotinaExercicio_rotinaId_fkey" FOREIGN KEY ("rotinaId") REFERENCES "RotinaMusculacao"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RotinaExercicio" ADD CONSTRAINT "RotinaExercicio_exercicioId_fkey" FOREIGN KEY ("exercicioId") REFERENCES "Exercicio"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

┌─────────────────────────────────────────────────────────┐
│  Update available 5.22.0 -> 7.8.0                       │
│                                                         │
│  This is a major update - please follow the guide at    │
│  https://pris.ly/d/major-version-upgrade                │
│                                                         │
│  Run the following to update                            │
│    npm i --save-dev prisma@latest                       │
│    npm i @prisma/client@latest                          │
└─────────────────────────────────────────────────────────┘
