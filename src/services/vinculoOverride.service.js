// PR #44 (Sprint 16 — Bloco C) — Overrides de vínculo Aluno↔Professor.
// PR #45 (Sprint 16 — Bloco D) — Migrado pra usar logAudit() unificado
// (substitui prisma.vinculoAuditLog.create*). VinculoAuditLog foi
// absorvido em AuditLog na migration 20260527_audit_log_unificado.
//
// Mudança chave de comportamento: audit é gravado APÓS o commit da
// transação (fire-and-forget). Antes era dentro do tx.vinculoAuditLog
// — agora se a transação falhar, NADA é logado (consistência: só
// auditamos fatos consumados, não intenções revertidas).

import { prisma } from '../lib/prisma.js';
import { HttpError } from '../middleware/errorHandler.js';
import { logAudit, AUDIT_ACTIONS } from '../lib/auditLog.js';

// ──────────────────────────────────────────────────────────────────────
// substituirVinculoProfessor — operação principal (PUT)
// ──────────────────────────────────────────────────────────────────────

export async function substituirVinculoProfessor({ alunoId, professorId, motivo, atorUserId, requestMeta }) {
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
    }

    // 2. Criar o novo vínculo.
    const novo = await tx.vinculoProfessor.create({
      data: { alunoId, professorId },
      select: { id: true, alunoId: true, professorId: true, criadoEm: true },
    });

    return { novo, removidos: idsAQuebrar.length, removidosDados: existentes };
  });

  // PR #45 — audit DEPOIS do commit (fire-and-forget). Se a transação
  // falhar, nada é logado. Se logAudit falhar, transação já commitou.
  for (const v of result.removidosDados) {
    logAudit({
      action: AUDIT_ACTIONS.VINCULO_QUEBRAR_PROF,
      entityType: 'Aluno',
      entityId: alunoId,
      payload: { professorId: v.professorId, motivo: motivo ?? null },
      atorUserId,
      ip: requestMeta?.ip,
      userAgent: requestMeta?.userAgent,
    });
  }
  logAudit({
    action: AUDIT_ACTIONS.VINCULO_CRIAR_PROF,
    entityType: 'Aluno',
    entityId: alunoId,
    payload: { professorId, motivo: motivo ?? null },
    atorUserId,
    ip: requestMeta?.ip,
    userAgent: requestMeta?.userAgent,
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

export async function removerVinculoProfessor({ alunoId, motivo, atorUserId, requestMeta }) {
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

  await prisma.vinculoProfessor.deleteMany({
    where: { alunoId },
  });

  // PR #45 — audit pós-delete (fire-and-forget). 1 entry por vínculo.
  for (const v of existentes) {
    logAudit({
      action: AUDIT_ACTIONS.VINCULO_QUEBRAR_PROF,
      entityType: 'Aluno',
      entityId: alunoId,
      payload: { professorId: v.professorId, motivo: motivo ?? null },
      atorUserId,
      ip: requestMeta?.ip,
      userAgent: requestMeta?.userAgent,
    });
  }

  return { success: true, noop: false, removidos: existentes.length };
}
