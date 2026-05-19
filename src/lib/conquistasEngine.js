import { prisma } from './prisma.js';
import { firePush, payloadConquistaDesbloqueada } from './pushTriggers.js';
import {
  getConquistasPorTrigger,
} from '../data/conquistasCatalogo.js';
import { computeStreak } from '../services/streak.service.js';

// PR #31 — Motor de avaliação de conquistas.
//
// CONTRATO:
//   avaliarConquistas({ alunoId, trigger, contexto })
//   - Lista códigos do catálogo relacionados ao trigger.
//   - Pra cada, roda o AVALIADOR que diz "bate condição agora? sim/não".
//   - Filtra os já desbloqueados (idempotência via @@unique no DB).
//   - Insere os novos.
//   - Dispara push pra cada novo desbloqueio (fire-and-forget reusando pushTriggers).
//
// FILOSOFIA:
//   - Idempotente: chamar 2x não duplica nada (constraint + filtro).
//   - Fail-soft: erro NÃO propaga. Engine é colateral, não pode derrubar
//     o caminho crítico (salvarExecucao, criar promoção, etc).
//   - Caller usa via queueMicrotask (padrão PR #27 / fire-and-forget).
//
// TRIGGER × AVALIADOR:
//   STREAK           — avalia streak atual contra c.threshold.
//   RP_FIRST         — desbloqueia na 1ª vez que aluno tem RP em modalidade.
//   PACE_THRESHOLD   — desbloqueia quando o pace do RP é ≤ c.segPorKm.
//   FAIXA_PROMOCAO   — desbloqueia em promoção (qualquer ou faixa-alvo).

// Hook pra testes — injeta um dispatcher mock sem mexer no push real.
let _firePush = firePush;
export function __setFirePushForTests(fn) { _firePush = fn; }
export function __resetFirePushForTests() { _firePush = firePush; }

/**
 * Avalia conquistas pra um aluno após um evento.
 *
 * @param {object} args
 * @param {string} args.alunoId
 * @param {'STREAK'|'RP_FIRST'|'PACE_THRESHOLD'|'FAIXA_PROMOCAO'} args.trigger
 * @param {object} [args.contexto] — payload do evento (treinoId, novosRecordes, etc).
 *
 * @returns {Promise<Array<{codigo: string, conquista: object}>>}
 *   Novos desbloqueios (vazio quando nada novo).
 */
export async function avaliarConquistas({ alunoId, trigger, contexto = {} }) {
  if (!alunoId) return [];

  const candidatas = getConquistasPorTrigger(trigger);
  if (candidatas.length === 0) return [];

  const avaliador = AVALIADORES[trigger];
  if (!avaliador) return [];

  let codigosQueBaterem;
  try {
    codigosQueBaterem = await avaliador({ alunoId, contexto, candidatas });
  } catch (err) {
    // Fail-soft: erro de query/avaliação não propaga. Loga e segue.
    console.warn(JSON.stringify({
      level: 'warn',
      msg: 'conquistas-avaliador-falhou',
      trigger, alunoId, error: err?.message,
    }));
    return [];
  }
  if (codigosQueBaterem.length === 0) return [];

  // Idempotência: descarta códigos já registrados pro aluno. Combina
  // com @@unique no DB pra defesa em camadas (race entre 2 avaliações
  // ainda pode tentar inserir, mas constraint pega).
  const jaDesbloqueadas = await prisma.conquistaDesbloqueada.findMany({
    where: { alunoId, codigo: { in: codigosQueBaterem } },
    select: { codigo: true },
  });
  const setJa = new Set(jaDesbloqueadas.map((c) => c.codigo));
  const novosCodigos = codigosQueBaterem.filter((c) => !setJa.has(c));
  if (novosCodigos.length === 0) return [];

  // Insere unlocks. createMany ignora duplicatas via skipDuplicates
  // (defesa contra race condition entre 2 chamadas paralelas).
  await prisma.conquistaDesbloqueada.createMany({
    data: novosCodigos.map((codigo) => ({
      alunoId,
      codigo,
      contexto: contexto && Object.keys(contexto).length > 0 ? contexto : null,
    })),
    skipDuplicates: true,
  });

  // Resolve userId do aluno pra disparo de push. Single query.
  const aluno = await prisma.aluno.findUnique({
    where: { id: alunoId },
    select: { userId: true },
  });
  const userId = aluno?.userId;

  // Hidrata e dispara push por cada novo desbloqueio. firePush é
  // fire-and-forget — não bloqueia o caller mesmo se push estiver off.
  const novos = [];
  for (const codigo of novosCodigos) {
    const conquista = candidatas.find((c) => c.codigo === codigo);
    if (!conquista) continue;
    novos.push({ codigo, conquista });
    if (userId) {
      _firePush({
        userId,
        payload: payloadConquistaDesbloqueada(conquista),
        trigger: `conquista-${codigo}`,
      });
    }
  }

  return novos;
}

// ─── Avaliadores ────────────────────────────────────────────────────

const AVALIADORES = {
  STREAK: async ({ alunoId, candidatas }) => {
    // Reusa cálculo do streak.service. Query única.
    const rows = await prisma.$queryRaw`
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
    `;
    const { atual } = computeStreak(rows);
    // Retorna TODAS as conquistas cujo threshold ≤ streak atual. A
    // dedupe contra ConquistaDesbloqueada cuida do resto.
    return candidatas
      .filter((c) => typeof c.threshold === 'number' && atual >= c.threshold)
      .map((c) => c.codigo);
  },

  RP_FIRST: async ({ alunoId, contexto, candidatas }) => {
    // contexto.novosRecordes vem do salvarExecucao. Se vazio, nada a fazer.
    const novos = Array.isArray(contexto?.novosRecordes) ? contexto.novosRecordes : [];
    if (novos.length === 0) return [];

    // Pra cada candidata por modalidade, conta total de RPs do aluno
    // naquela modalidade. Se ===1 (acabou de ganhar o primeiro), desbloqueia.
    const codigosDisparados = [];
    for (const c of candidatas) {
      if (!c.modalidade) continue;
      const count = await prisma.recordePessoal.count({
        where: { alunoId, modalidade: c.modalidade },
      });
      if (count === 1) {
        // Acabou de bater o primeiro RP daquela modalidade (a row já existe).
        codigosDisparados.push(c.codigo);
      }
    }
    return codigosDisparados;
  },

  PACE_THRESHOLD: async ({ contexto, candidatas }) => {
    // contexto.novosRecordes inclui RPs de pace recém criados.
    // Cada RP de pace tem `exercicio` = '5k' / '10k' / '21k' / '42k'
    // e `valor` em seg/km (lower = melhor).
    const novos = Array.isArray(contexto?.novosRecordes) ? contexto.novosRecordes : [];
    if (novos.length === 0) return [];

    const codigos = [];
    for (const rp of novos) {
      const segPorKm = Number(rp?.valor);
      const metrica = String(rp?.exercicio ?? '').toLowerCase();
      if (!Number.isFinite(segPorKm) || !metrica) continue;
      for (const c of candidatas) {
        if (c.metricaPace !== metrica) continue;
        if (typeof c.segPorKm !== 'number') continue;
        if (segPorKm <= c.segPorKm) {
          codigos.push(c.codigo);
        }
      }
    }
    return codigos;
  },

  FAIXA_PROMOCAO: async ({ contexto, candidatas }) => {
    // contexto.faixa = string da promoção recém criada.
    const faixa = String(contexto?.faixa ?? '').toUpperCase();
    if (!faixa) return [];
    return candidatas
      .filter((c) => c.faixaAlvo === null || c.faixaAlvo === faixa)
      .map((c) => c.codigo);
  },
};

export const __internal = { AVALIADORES };
