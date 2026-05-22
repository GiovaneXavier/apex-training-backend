// PR #41b — Motor de match Strava ↔ Treino.
//
// Orquestra:
//   1. Buscar candidatos (mesmo aluno, ±2 dias, sem stravaActivityId).
//   2. Filtrar cooldown (MatchRejeitado).
//   3. Scorear via lib/stravaScore.calcularScore.
//   4. Aplicar guards anti-falso-positivo:
//      - Brick (multi-modalidade no mesmo dia) → força Tier 2.
//      - Multi-match (2+ candidatos score≥0.92) → força Tier 2.
//   5. Tier routing:
//      ≥0.92 → vincula Treino (Tier 1, auto).
//      0.65..0.91 → cria StravaSugestao PENDENTE (Tier 2, opt-in).
//      <0.65 → ignora silenciosamente.
//
// Idempotência: se sugestão já existe para a atividade, não duplica.
// O caller (processWebhookEvent) também é idempotente — webhook re-disparado
// no Strava é seguro de processar 2x.

import { prisma } from '../lib/prisma.js';
import { HttpError } from '../middleware/errorHandler.js';
import { calcularScore, modalidadeFromStravaType } from '../lib/stravaScore.js';

export const TIER1_AUTO_THRESHOLD = 0.92;
export const TIER2_MIN_THRESHOLD = 0.65;
const JANELA_DIAS = 2;
const MS_POR_DIA = 86_400_000;

// ──────────────────────────────────────────────────────────────
// extrairPrescricao — normaliza o JSON detalhes em entrada do score.
// Funciona pra corrida (km), ciclismo (km + min) e natação (M na soma de
// blocos via mapeamento implícito). Musculação não tem dist/dur prescrita
// → retorna null em ambos (score neutro 0.5, esperado).
// ──────────────────────────────────────────────────────────────
export function extrairPrescricao(treino) {
  const d = treino?.detalhes ?? {};

  let distanciaPrescritaM = null;
  if (typeof d.distanciaKm === 'number' && d.distanciaKm > 0) {
    distanciaPrescritaM = d.distanciaKm * 1000;
  } else if (typeof d.distanciaM === 'number' && d.distanciaM > 0) {
    distanciaPrescritaM = d.distanciaM;
  } else if (Array.isArray(d.blocos)) {
    // Soma de blocos.distanciaM (natação) ou blocos.distanciaKm (corrida estruturada)
    let somaM = 0;
    for (const b of d.blocos) {
      if (typeof b.distanciaM === 'number') somaM += b.distanciaM * (b.repeticoes ?? 1);
      else if (typeof b.distanciaKm === 'number') somaM += b.distanciaKm * 1000;
    }
    if (somaM > 0) distanciaPrescritaM = somaM;
  }

  let duracaoPrescritaSeg = null;
  if (typeof d.duracaoSeg === 'number' && d.duracaoSeg > 0) {
    duracaoPrescritaSeg = d.duracaoSeg;
  } else if (typeof d.duracaoMin === 'number' && d.duracaoMin > 0) {
    duracaoPrescritaSeg = d.duracaoMin * 60;
  }

  let zonaFcAlvo = null;
  if (typeof d.fcAlvoMin === 'number' && typeof d.fcAlvoMax === 'number') {
    zonaFcAlvo = { min: d.fcAlvoMin, max: d.fcAlvoMax };
  }

  return { distanciaPrescritaM, duracaoPrescritaSeg, zonaFcAlvo };
}

// ──────────────────────────────────────────────────────────────
// matchAtividade — entrypoint chamado pelo processWebhookEvent.
//
// Argumento esperado: registro persistido de AtividadeStrava
// ({ id, alunoId, stravaId, tipo, distanciaM, duracaoSeg, fcMedia, iniciadoEm }).
//
// Retorno estruturado (nunca lança em fluxo normal):
//   { acao: 'auto_match'|'sugestao'|'ignorado', motivo?, tier?, score?, ... }
// ──────────────────────────────────────────────────────────────
export async function matchAtividade(atividade) {
  if (!atividade?.id || !atividade?.alunoId) {
    return { acao: 'ignorado', motivo: 'atividade_invalida' };
  }

  // Idempotência: se já existe sugestão para essa atividade, ou
  // se algum Treino já a vinculou via Tier 1, encerra silenciosamente.
  const [sugExistente, treinoJaVinculado] = await Promise.all([
    prisma.stravaSugestao.findUnique({ where: { atividadeStravaId: atividade.id } }),
    prisma.treino.findUnique({ where: { stravaActivityId: atividade.stravaId } }),
  ]);
  if (sugExistente) {
    return { acao: 'ignorado', motivo: 'sugestao_ja_existe', sugestaoId: sugExistente.id };
  }
  if (treinoJaVinculado) {
    return { acao: 'ignorado', motivo: 'treino_ja_vinculado', treinoId: treinoJaVinculado.id };
  }

  // 1. Janela ±2 dias de candidatos sem vínculo.
  const iniciadoEm = new Date(atividade.iniciadoEm);
  const janelaIni = new Date(iniciadoEm.getTime() - JANELA_DIAS * MS_POR_DIA);
  const janelaFim = new Date(iniciadoEm.getTime() + JANELA_DIAS * MS_POR_DIA);

  const candidatos = await prisma.treino.findMany({
    where: {
      alunoId: atividade.alunoId,
      stravaActivityId: null,
      dataAlvo: { gte: janelaIni, lte: janelaFim },
    },
  });
  if (candidatos.length === 0) {
    return { acao: 'ignorado', motivo: 'sem_candidatos' };
  }

  // 2. Cooldown — filtra treinos que já recusaram esta atividade.
  const cooldown = await prisma.matchRejeitado.findMany({
    where: {
      stravaActivityId: atividade.stravaId,
      treinoId: { in: candidatos.map((c) => c.id) },
    },
    select: { treinoId: true },
  });
  const bloqueados = new Set(cooldown.map((c) => c.treinoId));
  const elegiveis = candidatos.filter((c) => !bloqueados.has(c.id));
  if (elegiveis.length === 0) {
    return { acao: 'ignorado', motivo: 'cooldown' };
  }

  // 3. Score
  const scored = elegiveis.map((t) => {
    const result = calcularScore(
      {
        tipo: atividade.tipo,
        distanciaM: atividade.distanciaM,
        duracaoSeg: atividade.duracaoSeg,
        iniciadoEm: atividade.iniciadoEm,
        fcMedia: atividade.fcMedia,
      },
      {
        modalidade: t.modalidade,
        dataAlvo: t.dataAlvo,
        ...extrairPrescricao(t),
      },
    );
    return { treino: t, ...result };
  });

  // 4a. GUARD — Brick workout (multi-modalidade no mesmo dia civil).
  const isBrick = await detectarBrickWorkout(atividade);
  if (isBrick) {
    const tier2 = scored.filter((s) => s.score >= TIER2_MIN_THRESHOLD);
    if (tier2.length === 0) return { acao: 'ignorado', motivo: 'brick_sem_score' };
    const melhor = pickMelhor(tier2);
    const sug = await persistirSugestao(atividade, melhor);
    return {
      acao: 'sugestao',
      motivo: 'brick_veto',
      tier: 2,
      sugestaoId: sug.id,
      treinoId: melhor.treino.id,
      score: melhor.score,
    };
  }

  // 4b. GUARD — Multi-match (2+ candidatos ≥0.92).
  const altos = scored.filter((s) => s.score >= TIER1_AUTO_THRESHOLD);
  if (altos.length >= 2) {
    const melhor = pickMelhor(altos);
    const sug = await persistirSugestao(atividade, melhor);
    return {
      acao: 'sugestao',
      motivo: 'multi_match_veto',
      tier: 2,
      sugestaoId: sug.id,
      treinoId: melhor.treino.id,
      score: melhor.score,
    };
  }

  // 5. Tier routing
  const melhor = pickMelhor(scored);
  if (melhor.score < TIER2_MIN_THRESHOLD) {
    return { acao: 'ignorado', motivo: 'score_baixo', score: melhor.score };
  }
  if (melhor.score >= TIER1_AUTO_THRESHOLD) {
    return vincularTier1(atividade, melhor);
  }
  const sug = await persistirSugestao(atividade, melhor);
  return {
    acao: 'sugestao',
    tier: 2,
    sugestaoId: sug.id,
    treinoId: melhor.treino.id,
    score: melhor.score,
  };
}

// ──────────────────────────────────────────────────────────────
// Helpers de persistência
// ──────────────────────────────────────────────────────────────

function pickMelhor(scored) {
  return [...scored].sort((a, b) => b.score - a.score)[0];
}

async function vincularTier1(atividade, scored) {
  await prisma.treino.update({
    where: { id: scored.treino.id },
    data: {
      stravaActivityId: atividade.stravaId,
      status: 'CONCLUIDO',
      finalizadoEm: scored.treino.finalizadoEm ?? new Date(),
      // PR #41c — sinaliza "aluno ainda não viu este auto-match".
      // Dashboard filtra `stravaActivityId && !stravaAutoMatchAck` para
      // disparar toast "X autopreenchidos — Desfazer". Frontend marca
      // como true via POST /treinos/strava-ack após exibir o toast.
      stravaAutoMatchAck: false,
    },
  });
  return {
    acao: 'auto_match',
    tier: 1,
    treinoId: scored.treino.id,
    score: scored.score,
  };
}

async function persistirSugestao(atividade, scored) {
  return prisma.stravaSugestao.create({
    data: {
      alunoId: atividade.alunoId,
      treinoId: scored.treino.id,
      atividadeStravaId: atividade.id,
      score: scored.score,
      scoreBreakdown: scored.breakdown,
      status: 'PENDENTE',
    },
  });
}

// Brick: 2+ MODALIDADES diferentes no mesmo dia civil (UTC).
// Usa o mapeamento tipo Strava → modalidade derivada — assim Run de manhã
// + Treadmill à tarde NÃO é brick (mesma modalidade=CORRIDA), mas Run + Ride
// dispara a guarda.
async function detectarBrickWorkout(atividade) {
  const inicioDia = new Date(atividade.iniciadoEm);
  inicioDia.setUTCHours(0, 0, 0, 0);
  const fimDia = new Date(inicioDia.getTime() + MS_POR_DIA);

  const outras = await prisma.atividadeStrava.findMany({
    where: {
      alunoId: atividade.alunoId,
      iniciadoEm: { gte: inicioDia, lt: fimDia },
      NOT: { id: atividade.id },
    },
    select: { tipo: true },
  });

  const modalidades = new Set();
  const atualMod = modalidadeFromStravaType(atividade.tipo);
  if (atualMod) modalidades.add(atualMod);
  for (const o of outras) {
    const m = modalidadeFromStravaType(o.tipo);
    if (m) modalidades.add(m);
  }
  return modalidades.size >= 2;
}

// ──────────────────────────────────────────────────────────────
// Mutators expostos para o controller HTTP
// ──────────────────────────────────────────────────────────────

export async function listarSugestoesPendentes(userId) {
  const aluno = await prisma.aluno.findUnique({ where: { userId }, select: { id: true } });
  if (!aluno) throw new HttpError(404, 'Perfil de aluno não encontrado');
  return prisma.stravaSugestao.findMany({
    where: { alunoId: aluno.id, status: 'PENDENTE' },
    orderBy: { criadaEm: 'desc' },
    include: {
      treino: { select: { id: true, titulo: true, modalidade: true, dataAlvo: true, status: true } },
      atividade: {
        select: {
          id: true,
          stravaId: true,
          tipo: true,
          nome: true,
          distanciaM: true,
          duracaoSeg: true,
          iniciadoEm: true,
        },
      },
    },
  });
}

// Aceitar sugestão: transação atômica.
//   1. Atualiza sugestão → ACEITA + resolvidaEm.
//   2. Atualiza Treino → vincula stravaActivityId + CONCLUIDO.
//   3. Invalida quaisquer outras sugestões PENDENTES concorrentes
//      (mesma atividade OU mesmo treino) → status=EXPIRADA.
//   Tudo em $transaction pra impedir estado inconsistente sob race.
export async function aceitarSugestao({ userId, sugestaoId }) {
  const aluno = await prisma.aluno.findUnique({ where: { userId }, select: { id: true } });
  if (!aluno) throw new HttpError(404, 'Perfil de aluno não encontrado');

  const sug = await prisma.stravaSugestao.findUnique({
    where: { id: sugestaoId },
    include: { atividade: true, treino: true },
  });
  if (!sug) throw new HttpError(404, 'Sugestão não encontrada');
  if (sug.alunoId !== aluno.id) throw new HttpError(403, 'Sugestão não pertence ao aluno');
  if (sug.status !== 'PENDENTE') throw new HttpError(409, `Sugestão já está ${sug.status}`);

  const agora = new Date();

  return prisma.$transaction(async (tx) => {
    await tx.stravaSugestao.update({
      where: { id: sug.id },
      data: { status: 'ACEITA', resolvidaEm: agora },
    });
    await tx.treino.update({
      where: { id: sug.treinoId },
      data: {
        stravaActivityId: sug.atividade.stravaId,
        status: 'CONCLUIDO',
        finalizadoEm: sug.treino.finalizadoEm ?? agora,
      },
    });
    // Invalida concorrentes (mesmo treino OU mesma atividade).
    await tx.stravaSugestao.updateMany({
      where: {
        id: { not: sug.id },
        status: 'PENDENTE',
        OR: [{ treinoId: sug.treinoId }, { atividadeStravaId: sug.atividadeStravaId }],
      },
      data: { status: 'EXPIRADA', resolvidaEm: agora },
    });
    return { ok: true, treinoId: sug.treinoId, sugestaoId: sug.id };
  });
}

export async function rejeitarSugestao({ userId, sugestaoId }) {
  const aluno = await prisma.aluno.findUnique({ where: { userId }, select: { id: true } });
  if (!aluno) throw new HttpError(404, 'Perfil de aluno não encontrado');

  const sug = await prisma.stravaSugestao.findUnique({
    where: { id: sugestaoId },
    include: { atividade: { select: { stravaId: true } } },
  });
  if (!sug) throw new HttpError(404, 'Sugestão não encontrada');
  if (sug.alunoId !== aluno.id) throw new HttpError(403, 'Sugestão não pertence ao aluno');
  if (sug.status !== 'PENDENTE') throw new HttpError(409, `Sugestão já está ${sug.status}`);

  const agora = new Date();
  return prisma.$transaction(async (tx) => {
    await tx.stravaSugestao.update({
      where: { id: sug.id },
      data: { status: 'REJEITADA', resolvidaEm: agora },
    });
    await tx.matchRejeitado.upsert({
      where: {
        treinoId_stravaActivityId: {
          treinoId: sug.treinoId,
          stravaActivityId: sug.atividade.stravaId,
        },
      },
      create: {
        alunoId: sug.alunoId,
        treinoId: sug.treinoId,
        stravaActivityId: sug.atividade.stravaId,
        motivo: 'manual_reject',
        scoreNaRecusa: sug.score,
      },
      update: {}, // idempotente
    });
    return { ok: true, sugestaoId: sug.id };
  });
}

// Desfazer Tier 1 — aluno regrediu um auto-match.
// Zera o vínculo no Treino + grava cooldown pra impedir re-match automático.
export async function desfazerMatch({ userId, treinoId }) {
  const aluno = await prisma.aluno.findUnique({ where: { userId }, select: { id: true } });
  if (!aluno) throw new HttpError(404, 'Perfil de aluno não encontrado');

  const treino = await prisma.treino.findUnique({ where: { id: treinoId } });
  if (!treino) throw new HttpError(404, 'Treino não encontrado');
  if (treino.alunoId !== aluno.id) throw new HttpError(403, 'Treino não pertence ao aluno');
  if (!treino.stravaActivityId) throw new HttpError(409, 'Treino não está vinculado a uma atividade Strava');

  const stravaActivityId = treino.stravaActivityId;
  const agora = new Date();

  return prisma.$transaction(async (tx) => {
    await tx.treino.update({
      where: { id: treino.id },
      data: {
        stravaActivityId: null,
        status: 'PENDENTE',
        finalizadoEm: null,
      },
    });
    await tx.matchRejeitado.upsert({
      where: {
        treinoId_stravaActivityId: {
          treinoId: treino.id,
          stravaActivityId,
        },
      },
      create: {
        alunoId: aluno.id,
        treinoId: treino.id,
        stravaActivityId,
        motivo: 'undone_tier1',
      },
      update: { criadoEm: agora },
    });
    return { ok: true, treinoId: treino.id };
  });
}
