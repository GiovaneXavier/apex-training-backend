-- PR #18b — Sprint 6: PlanoAlimentar (PDF + S3 + metas).
--
-- Decisão de produto: NÃO modelamos refeições estruturadas. Nutris usam
-- software de nicho (WebDiet/Dietbox) que exporta PDF. Esta tabela só
-- guarda referência ao arquivo + campo livre de "foco/metas".

-- CreateTable
CREATE TABLE "PlanoAlimentar" (
    "id" TEXT NOT NULL,
    "alunoId" TEXT NOT NULL,
    "nutricionistaId" TEXT,
    "pdfUrl" TEXT NOT NULL,
    "pdfKey" TEXT,
    "metasText" TEXT,
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizadoEm" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlanoAlimentar_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- Query principal: "plano vigente do aluno" filtra por (alunoId, ativo=true).
-- Sem partial unique aqui — exclusividade do `ativo=true` por aluno é mantida
-- pelo service via $transaction (updateMany ativo=false → create ativo=true).
CREATE INDEX "PlanoAlimentar_alunoId_ativo_idx" ON "PlanoAlimentar"("alunoId", "ativo");

-- AddForeignKey
ALTER TABLE "PlanoAlimentar" ADD CONSTRAINT "PlanoAlimentar_alunoId_fkey"
    FOREIGN KEY ("alunoId") REFERENCES "Aluno"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- SetNull no nutricionista: se o profissional sair da plataforma, o plano
-- permanece com o aluno (o PDF físico já é dele) só perde a referência
-- a quem prescreveu.
ALTER TABLE "PlanoAlimentar" ADD CONSTRAINT "PlanoAlimentar_nutricionistaId_fkey"
    FOREIGN KEY ("nutricionistaId") REFERENCES "Nutricionista"("id") ON DELETE SET NULL ON UPDATE CASCADE;
