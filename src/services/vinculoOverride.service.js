// PR #44 (Sprint 16 — Bloco C) — Overrides de vínculo Aluno↔Professor.
//
// Operações administrativas de exceção (troca de coach, professor que
// sai da plataforma, aluno órfão). Atomicamente substitui ou remove
// vínculos, gravando rastro em VinculoAuditLog.
//
// Decisões batidas no briefing:
//   D2 — "trocar" = substituir todos (1:1 implícito): PUT é idempotente
//        e atomicamente quebra os antigos + cria o novo
//   D3 — motivo persistido em VinculoAuditLog (mini-audit dedicado,
//        fundação do Bloco D)
//   D4 — hard delete do VinculoProfessor (rastro fica no audit log)
//   D7 — motivo opcional (não bloqueia ação rápida)
//
// Idempotência: chamar PUT com mesmo professorId N vezes resulta no
// mesmo estado final (vínculo único entre aluno e prof). Segunda
// chamada não duplica nem registra audit log redundante.

import { prisma } from '../lib/prisma.js';
import { HttpError } from '../middleware/errorHandler.js';

// ──────────────────────────────────────────────────────────────────────
// substituirVinculoProfessor — operação principal (PUT)
// ──────────────────────────────────────────────────────────────────────

export async function substituirVinculoProfessor({ alunoId, professorId, motivo, atorUserId }) {
  // Guard 1: aluno existe e está ativo.
  const aluno = await prisma.aluno.findUnique({
    where: { id: alunoId },
    select: { id: true, user: { select: { ativo: true } } },
  });
  if (!aluno) throw new HttpError(404, 'Aluno não encontrado');
  if (!aluno.user.ativo) {
    throw new HttpError(422, 'Aluno está inativo — reative antes de gerenciar vínculos');
  }

  // Guard 2: professor existe e está ativo.
  const professor = await prisma.professor.findUnique({
    where: { id: professorId },
    select: { id: true, user: { select: { ativo: true } } },
  });
  if (!professor) throw new HttpError(404, 'Professor não encontrado');
  if (!professor.user.ativo) {
    throw new HttpError(422, 'Professor está inativo — não pode receber novos vínculos');
  }

  // Snapshot dos vínculos atuais ANTES da transação pra:
  //   1. Detectar idempotência (já é o único vínculo? noop)
  //   2. Saber quais audit logs de "quebrar_prof" gerar
  const existentes = await prisma.vinculoProfessor.findMany({
    where: { alunoId },
    select: { id: true, professorId: true },
  });

  // Idempotência (D2): se já existe exatamente esse vínculo e é o único,
  // retorna sucesso sem tocar no banco nem registrar audit redundante.
  const jaTemAlvo = existentes.some((v) => v.professorId === professorId);
  if (jaTemAlvo && existentes.length === 1) {
    const vinculo = existentes[0];
    return {
      success: true,
      noop: true,
      vinculo: {
        id: vinculo.id,
        alunoId,
        professorId,
      },
      removidos: 0,
    };
  }

  // Transação atômica: quebrar todos + criar novo + audit log.
  // Estado consistente garantido — se qualquer step falhar, rollback
  // completo via Postgres transaction.
  const result = await prisma.$transaction(async (tx) => {
    // 1. Quebrar TODOS os vínculos atuais (mesmo o do target — pra
    //    garantir reset limpo se houver inconsistência legada com N
    //    vínculos pra mesmo professor).
    const idsAQuebrar = existentes.map((v) => v.id);
    if (idsAQuebrar.length > 0) {
      await tx.vinculoProfessor.deleteMany({
        where: { id: { in: idsAQuebrar } },
      });
      // Audit "quebrar_prof" — 1 entry por vínculo removido.
      await tx.vinculoAuditLog.createMany({
        data: existentes.map((v) => ({
          acao: 'quebrar_prof',
          alunoId,
          professorId: v.professorId,
          motivo: motivo ?? null,
          atorUserId,
        })),
      });
    }

    // 2. Criar o novo vínculo.
    const novo = await tx.vinculoProfessor.create({
      data: { alunoId, professorId },
      select: { id: true, alunoId: true, professorId: true, criadoEm: true },
    });
    await tx.vinculoAuditLog.create({
      data: {
        acao: 'criar_prof',
        alunoId,
        professorId,
        motivo: motivo ?? null,
        atorUserId,
      },
    });

    return { novo, removidos: idsAQuebrar.length };
  });

  return {
    success: true,
    noop: false,
    vinculo: result.novo,
    removidos: result.removidos,
  };
}

// ──────────────────────────────────────────────────────────────────────
// removerVinculoProfessor — DELETE quebra TODOS sem substituir
// ──────────────────────────────────────────────────────────────────────

export async function removerVinculoProfessor({ alunoId, motivo, atorUserId }) {
  const aluno = await prisma.aluno.findUnique({
    where: { id: alunoId },
    select: { id: true },
  });
  if (!aluno) throw new HttpError(404, 'Aluno não encontrado');

  const existentes = await prisma.vinculoProfessor.findMany({
    where: { alunoId },
    select: { id: true, professorId: true },
  });

  // Idempotência: nada pra remover.
  if (existentes.length === 0) {
    return { success: true, noop: true, removidos: 0 };
  }

  await prisma.$transaction(async (tx) => {
    await tx.vinculoProfessor.deleteMany({
      where: { alunoId },
    });
    await tx.vinculoAuditLog.createMany({
      data: existentes.map((v) => ({
        acao: 'quebrar_prof',
        alunoId,
        professorId: v.professorId,
        motivo: motivo ?? null,
        atorUserId,
      })),
    });
  });

  return { success: true, noop: false, removidos: existentes.length };
}
