// PR #42 (Sprint 16 — Cockpit Fase 1) — Métricas globais do Admin.
//
// Endpoint read-only, sem schema novo. Agrega 9 queries Prisma em paralelo
// e devolve payload consolidado pro Dashboard de admin.
//
// Decisões batidas no briefing técnico:
//   - "Pendente" = User.ativo=false + tem perfil Professor/Nutricionista.
//   - Semana = SEG 00:00 → SEG 00:00 em BRT (America/Sao_Paulo, UTC-3).
//     Sem dependência nova (date-fns-tz) — offset fixo cobre os requisitos
//     atuais (Brasil sem DST desde 2019).
//   - Alertas só contam Alunos ATIVOS (user.ativo=true). Aluno desativado
//     não infla card de "sem atividade".
//   - taxaAdesao retorna `null` quando prescritosSemana=0 (frontend
//     distingue "sem dados" de 0% — evita NaN no React).

import { prisma } from '../lib/prisma.js';

// ──────────────────────────────────────────────────────────────────────
// Helpers de janela temporal — semana BRT
// ──────────────────────────────────────────────────────────────────────

// Offset fixo BRT = UTC-3. Sem DST no Brasil desde 2019. Se voltar,
// trocar pra date-fns-tz com zone 'America/Sao_Paulo'.
const BRT_OFFSET_MS = 3 * 60 * 60 * 1000;

/**
 * Calcula o início (SEG 00:00) e fim (próxima SEG 00:00) da semana
 * corrente em horário de Brasília, retornando os limites em UTC pra
 * uso direto em filtros do Prisma.
 *
 * Ex.: chamado às 14:00 BRT de quarta 2026-05-27
 *   → ini = 2026-05-25T03:00:00.000Z (SEG 00:00 BRT)
 *   → fim = 2026-06-01T03:00:00.000Z (SEG seguinte 00:00 BRT)
 */
export function semanaCorrenteBrt(now = new Date()) {
  // "Agora" como se BRT fosse UTC — simplifica o cálculo do dia da semana.
  const brtNow = new Date(now.getTime() - BRT_OFFSET_MS);
  const dow = brtNow.getUTCDay(); // 0=DOM..6=SAB
  // Distância até a segunda mais recente (segunda=1 → 0; domingo=0 → 6).
  const diasDesdeSegunda = (dow + 6) % 7;
  const iniBrt = new Date(Date.UTC(
    brtNow.getUTCFullYear(),
    brtNow.getUTCMonth(),
    brtNow.getUTCDate() - diasDesdeSegunda,
    0, 0, 0, 0,
  ));
  const fimBrt = new Date(iniBrt.getTime() + 7 * 24 * 60 * 60 * 1000);
  // Reverte o pseudo-UTC pro UTC real (BRT 00:00 = UTC 03:00).
  return {
    inicio: new Date(iniBrt.getTime() + BRT_OFFSET_MS),
    fim: new Date(fimBrt.getTime() + BRT_OFFSET_MS),
  };
}

// ──────────────────────────────────────────────────────────────────────
// Service principal
// ──────────────────────────────────────────────────────────────────────

export async function obterMetricasGlobais(now = new Date()) {
  const { inicio: semanaIni, fim: semanaFim } = semanaCorrenteBrt(now);
  const seteDiasAtras = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const [
    totalUsuarios,
    ativosUsuarios,
    porRoleRaw,
    professoresPendentes,
    nutrisPendentes,
    prescritosSemana,
    concluidosSemana,
    totalHistorico,
    alunosSemAtividade7d,
    alunosSemProfessor,
    alunosSemAlvo,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { ativo: true } }),
    prisma.user.groupBy({
      by: ['role'],
      where: { ativo: true },
      _count: { _all: true },
    }),
    prisma.professor.count({ where: { user: { ativo: false } } }),
    prisma.nutricionista.count({ where: { user: { ativo: false } } }),
    prisma.treino.count({
      where: { dataAlvo: { gte: semanaIni, lt: semanaFim } },
    }),
    prisma.treino.count({
      where: {
        status: 'CONCLUIDO',
        finalizadoEm: { gte: semanaIni, lt: semanaFim },
      },
    }),
    prisma.treino.count(),
    prisma.aluno.count({
      where: {
        user: { ativo: true },
        treinos: { none: { finalizadoEm: { gte: seteDiasAtras } } },
      },
    }),
    prisma.aluno.count({
      where: {
        user: { ativo: true },
        vinculosProf: { none: {} },
      },
    }),
    prisma.aluno.count({
      where: {
        user: { ativo: true },
        provas: { none: { prioridade: 'A', arquivada: false } },
      },
    }),
  ]);

  // groupBy devolve array — normaliza pra objeto com defaults zerados
  // pra UI sempre receber as 4 keys (evita "ALUNO undefined" no front).
  const porRole = { ALUNO: 0, PROFESSOR: 0, NUTRICIONISTA: 0, ADMIN: 0 };
  for (const row of porRoleRaw) porRole[row.role] = row._count._all;

  // Divisão por zero → null (decisão D4 do briefing). Frontend renderiza
  // "—" em vez de "0%" pra não enganar o leitor em semanas vazias.
  const taxaAdesao =
    prescritosSemana > 0
      ? Math.round((concluidosSemana / prescritosSemana) * 100) / 100
      : null;

  return {
    geradoEm: now.toISOString(),
    usuarios: {
      total: totalUsuarios,
      ativos: ativosUsuarios,
      porRole,
      pendentes: {
        professores: professoresPendentes,
        nutris: nutrisPendentes,
      },
    },
    treinos: {
      prescritosSemana,
      concluidosSemana,
      taxaAdesao,
      totalHistorico,
    },
    alertas: {
      alunosSemAtividade7d,
      alunosSemProfessor,
      alunosSemAlvo,
    },
  };
}
