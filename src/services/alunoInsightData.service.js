import { prisma } from '../lib/prisma.js';

import { computeStreak } from './streak.service.js';

// PR #32 — Snapshot agregador pro Weekly Check-in do Aluno.
//
// Responsabilidade ÚNICA: produzir fotografia determinística retrospectiva
// das últimas 4 semanas. Não chama IA. Não persiste.
//
// Reuso de fontes:
//   - Timeline unificada (Treino + AtividadeStrava): mesmo padrão do
//     coach.service (PR #17) e streak.service (PR #31).
//   - computeStreak: streak atual + máximo histórico.
//   - prisma.recordePessoal: RPs recentes (4 semanas).
//   - prisma.conquistaDesbloqueada: marcos desbloqueados (4 semanas).
//   - Tabela Treino direto pra RPE / readiness BJJ médios.
//   - Prova alvo: só dado, IA não calcula prep.
//
// Privacy: snapshot NÃO carrega nome do aluno — LLM não precisa, narrativa
// é em 2ª pessoa ("você"). PII zero no prompt.

const JANELA_SEMANAS = 4;
const JANELA_MS = JANELA_SEMANAS * 7 * 24 * 60 * 60 * 1000;

/**
 * @param {object} args
 * @param {string} args.alunoId
 * @returns {Promise<{
 *   janela: string,
 *   consistencia: { streakAtual, maximoHistorico, semanasValidasUltimas4, distribuicaoTreinos },
 *   volume: { totalTreinosConcluidos, treinosPulados, diasComAtividade },
 *   qualidade: { rpeMedioMusculacao, matTimeBjjSegundos, readinessMedioBjj },
 *   marcos: { rpsNovos, conquistasDesbloqueadas, totalConquistasAtivas },
 *   alvoProvaProximo: object|null,
 *   temDadosSuficientes: boolean,
 * }>}
 */
export async function buildAlunoInsightSnapshot({ alunoId }) {
  if (!alunoId) return emptySnapshot();

  const desde = new Date(Date.now() - JANELA_MS);

  const [
    treinosCompletos,
    stravaAtividades,
    treinosPulados,
    streakRows,
    rpsRecentes,
    conquistasRecentes,
    totalConquistas,
    proximaProva,
  ] = await Promise.all([
    // Treinos CONCLUIDO na janela — com detalhes pra extrair RPE e readiness.
    prisma.treino.findMany({
      where: {
        alunoId,
        status: 'CONCLUIDO',
        finalizadoEm: { gte: desde },
      },
      select: { id: true, modalidade: true, finalizadoEm: true, detalhes: true },
    }),
    prisma.atividadeStrava.findMany({
      where: { alunoId, iniciadoEm: { gte: desde } },
      select: { iniciadoEm: true, tipo: true },
    }),
    prisma.treino.count({
      where: {
        alunoId,
        status: 'PULADO',
        dataAlvo: { gte: desde },
      },
    }),
    // Streak via mesma query que streak.service usa.
    prisma.$queryRaw`
      WITH timeline AS (
        SELECT date_trunc('week', "finalizadoEm") AS semana
          FROM "Treino"
         WHERE "alunoId" = ${alunoId}
           AND status = 'CONCLUIDO'::"StatusTreino"
           AND "finalizadoEm" IS NOT NULL
           AND "finalizadoEm" >= date_trunc('week', NOW()) - INTERVAL '60 weeks'
         UNION ALL
        SELECT date_trunc('week', "iniciadoEm") AS semana
          FROM "AtividadeStrava"
         WHERE "alunoId" = ${alunoId}
           AND "iniciadoEm" >= date_trunc('week', NOW()) - INTERVAL '60 weeks'
      )
      SELECT semana, COUNT(*)::int AS atividades
        FROM timeline
       GROUP BY semana
       ORDER BY semana ASC
    `,
    prisma.recordePessoal.findMany({
      where: { alunoId, dataRecorde: { gte: desde } },
      select: { exercicio: true, valor: true, unidade: true, reps: true, modalidade: true },
      orderBy: { dataRecorde: 'desc' },
      take: 10,
    }),
    prisma.conquistaDesbloqueada.findMany({
      where: { alunoId, desbloqueadoEm: { gte: desde } },
      select: { codigo: true, desbloqueadoEm: true },
      orderBy: { desbloqueadoEm: 'desc' },
    }),
    prisma.conquistaDesbloqueada.count({ where: { alunoId } }),
    prisma.prova.findFirst({
      where: { alunoId, data: { gte: new Date() } },
      select: { nome: true, data: true, modalidade: true },
      orderBy: { data: 'asc' },
    }),
  ]);

  const consistencia = computeConsistencia({ treinosCompletos, stravaAtividades, streakRows });
  const qualidade = computeQualidade({ treinosCompletos });
  const diasComAtividade = countDiasUnicos([
    ...treinosCompletos.map((t) => t.finalizadoEm),
    ...stravaAtividades.map((s) => s.iniciadoEm),
  ]);

  const totalAtividades = treinosCompletos.length + stravaAtividades.length;
  const temDadosSuficientes = totalAtividades > 0;

  return {
    janela: `${JANELA_SEMANAS} semanas`,
    consistencia,
    volume: {
      totalTreinosConcluidos: treinosCompletos.length,
      atividadesStrava: stravaAtividades.length,
      treinosPulados,
      diasComAtividade,
    },
    qualidade,
    marcos: {
      rpsNovos: rpsRecentes.length,
      rpsDestaque: rpsRecentes.slice(0, 3).map((r) => ({
        exercicio: r.exercicio, valor: r.valor, unidade: r.unidade, reps: r.reps,
      })),
      conquistasDesbloqueadas: conquistasRecentes.map((c) => c.codigo),
      totalConquistasAtivas: totalConquistas,
    },
    alvoProvaProximo: proximaProva
      ? {
          nome: proximaProva.nome,
          dataAlvo: proximaProva.data.toISOString().slice(0, 10),
          diasAte: Math.ceil((proximaProva.data.getTime() - Date.now()) / 86_400_000),
        }
      : null,
    temDadosSuficientes,
  };
}

function emptySnapshot() {
  return {
    janela: `${JANELA_SEMANAS} semanas`,
    consistencia: {
      streakAtual: 0, maximoHistorico: 0, semanasValidasUltimas4: 0,
      distribuicaoTreinos: {},
    },
    volume: { totalTreinosConcluidos: 0, atividadesStrava: 0, treinosPulados: 0, diasComAtividade: 0 },
    qualidade: { rpeMedioMusculacao: null, matTimeBjjSegundos: null, readinessMedioBjj: null },
    marcos: { rpsNovos: 0, rpsDestaque: [], conquistasDesbloqueadas: [], totalConquistasAtivas: 0 },
    alvoProvaProximo: null,
    temDadosSuficientes: false,
  };
}

function computeConsistencia({ treinosCompletos, stravaAtividades, streakRows }) {
  const { atual, maximoHistorico, semanasUltimas12 } = computeStreak(streakRows);
  const semanasValidasUltimas4 = semanasUltimas12.slice(-4).filter((s) => s.valida).length;

  // Distribuição por modalidade nas últimas 4 semanas.
  const dist = {};
  for (const t of treinosCompletos) {
    dist[t.modalidade] = (dist[t.modalidade] || 0) + 1;
  }
  // Strava → modalidade aproximada (mesma heurística do coach.service).
  for (const s of stravaAtividades) {
    const tipo = String(s.tipo || '').toLowerCase();
    let mod = 'OUTRO';
    if (tipo.startsWith('run')) mod = 'CORRIDA';
    else if (tipo.startsWith('ride') || tipo.startsWith('bike') || tipo.startsWith('cycle')) mod = 'CICLISMO';
    else if (tipo.startsWith('swim')) mod = 'NATACAO';
    dist[mod] = (dist[mod] || 0) + 1;
  }

  return {
    streakAtual: atual,
    maximoHistorico,
    semanasValidasUltimas4,
    distribuicaoTreinos: dist,
  };
}

function computeQualidade({ treinosCompletos }) {
  // RPE médio MUSCULACAO: extrai do detalhes.exercicios[].realizado[].rpe.
  const rpes = [];
  let matTimeBjjTotal = 0;
  const readinessBjj = [];

  for (const t of treinosCompletos) {
    const d = t.detalhes || {};
    if (t.modalidade === 'MUSCULACAO' && Array.isArray(d.exercicios)) {
      for (const ex of d.exercicios) {
        const realizado = Array.isArray(ex.realizado) ? ex.realizado : [];
        for (const set of realizado) {
          if (typeof set?.rpe === 'number') rpes.push(set.rpe);
        }
      }
    }
    if (t.modalidade === 'JIU_JITSU' && d.realizado) {
      if (typeof d.realizado.matTimeSegundos === 'number') {
        matTimeBjjTotal += d.realizado.matTimeSegundos;
      }
      if (typeof d.realizado.readinessRating === 'number') {
        readinessBjj.push(d.realizado.readinessRating);
      }
    }
  }

  return {
    rpeMedioMusculacao: rpes.length > 0
      ? Math.round((rpes.reduce((a, b) => a + b, 0) / rpes.length) * 10) / 10
      : null,
    matTimeBjjSegundos: matTimeBjjTotal > 0 ? matTimeBjjTotal : null,
    readinessMedioBjj: readinessBjj.length > 0
      ? Math.round((readinessBjj.reduce((a, b) => a + b, 0) / readinessBjj.length) * 10) / 10
      : null,
  };
}

function countDiasUnicos(datas) {
  const set = new Set();
  for (const d of datas) {
    if (!d) continue;
    const iso = (d instanceof Date ? d : new Date(d)).toISOString().slice(0, 10);
    set.add(iso);
  }
  return set.size;
}

export const __internal = { computeConsistencia, computeQualidade, countDiasUnicos };
