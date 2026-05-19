import { prisma } from '../lib/prisma.js';
import { HttpError } from '../middleware/errorHandler.js';
import { resolveAlunoAccess } from '../lib/access.js';

// PR #31 — Streak semanal do aluno (Sprint 11).
//
// Streak NÃO é estado persistido — é função das atividades. Calculado
// on-the-fly via SQL com CTE. Evita race conditions de cron, evita
// backfills, e reusa o padrão de timeline já validado em coach.service.js
// (PR #17).
//
// REGRAS:
//   - Semana = segunda 00:00 → domingo 23:59:59 (ISO 8601).
//     date_trunc('week', t) no Postgres alinha em segunda.
//   - Semana válida = ≥3 atividades (Treino CONCLUIDO + AtividadeStrava).
//   - Streak atual = semanas válidas consecutivas terminando na semana
//     CORRENTE ou ANTERIOR (segunda/terça da semana atual ainda contam
//     o streak baseado na semana passada — atleta não foi punido por
//     "ainda não treinou essa semana").
//   - Janela de cálculo: 60 semanas. Cobre streak máximo de 52 semanas
//     + folga. Suficiente; passar disso fica pra futuro.

const JANELA_SEMANAS = 60;
const MIN_ATIVIDADES_POR_SEMANA = 3;

/**
 * @param {object} args
 * @param {{userId: string, role: string}} args.user — caller (ALUNO próprio OU PROFESSOR vinculado).
 * @param {string} [args.alunoId] — opcional. Se ALUNO, defaulta ao próprio.
 *
 * @returns {Promise<{
 *   atual: number,
 *   maximoHistorico: number,
 *   semanasUltimas12: Array<{semana: string, valida: boolean, atividades: number}>,
 * }>}
 */
export async function getStreakStats({ user, alunoId }) {
  const aluno = await resolveAlunoAccess({ user, alunoId });

  // Timeline unificada: treinos concluídos + atividades Strava por semana.
  // date_trunc('week', t) alinha em segunda (ISO 8601, padrão Postgres).
  // Filtra janela de JANELA_SEMANAS pra evitar full table scan.
  const rows = await prisma.$queryRaw`
    WITH timeline AS (
      SELECT date_trunc('week', "finalizadoEm") AS semana
        FROM "Treino"
       WHERE "alunoId" = ${aluno.id}
         AND status = 'CONCLUIDO'::"StatusTreino"
         AND "finalizadoEm" IS NOT NULL
         AND "finalizadoEm" >= date_trunc('week', NOW()) - (INTERVAL '1 week' * ${JANELA_SEMANAS})
       UNION ALL
      SELECT date_trunc('week', "iniciadoEm") AS semana
        FROM "AtividadeStrava"
       WHERE "alunoId" = ${aluno.id}
         AND "iniciadoEm" >= date_trunc('week', NOW()) - (INTERVAL '1 week' * ${JANELA_SEMANAS})
    ),
    semanas_agg AS (
      SELECT semana, COUNT(*)::int AS atividades
        FROM timeline
       GROUP BY semana
    )
    SELECT semana, atividades
      FROM semanas_agg
      ORDER BY semana ASC
  `;

  return computeStreak(rows);
}

// Função pura, separada pra testabilidade. Recebe rows ordenadas asc por
// semana e devolve o cálculo agregado. Sem queries.
export function computeStreak(rows) {
  // Mapa { ISO-da-semana → atividades }. Semanas sem atividade não
  // aparecem nas rows (são "zeros implícitos").
  const semanasMap = new Map();
  for (const r of rows) {
    const iso = toISODateOnly(r.semana);
    semanasMap.set(iso, Number(r.atividades) || 0);
  }

  // Constrói série densa das últimas JANELA_SEMANAS semanas — inclui as
  // sem atividade como 0. Necessário pra streak detectar gaps.
  const serie = construirSerieSemanas(JANELA_SEMANAS, semanasMap);

  // Streak ATUAL: conta semanas válidas regressivamente a partir da
  // semana CORRENTE. Se corrente não é válida MAS anterior é, conta a
  // partir da anterior (segunda/terça ainda não punem o atleta).
  const indiceCorrente = serie.length - 1;
  let inicio = indiceCorrente;
  if (!serie[indiceCorrente].valida && indiceCorrente > 0) {
    if (serie[indiceCorrente - 1].valida) {
      inicio = indiceCorrente - 1;
    } else {
      // Nem corrente nem anterior são válidas → streak zerou de fato.
      inicio = -1;
    }
  }

  let atual = 0;
  for (let i = inicio; i >= 0; i--) {
    if (serie[i].valida) atual++;
    else break;
  }

  // Streak máximo histórico: maior run de semanas válidas em toda a janela.
  let maximoHistorico = 0;
  let run = 0;
  for (const s of serie) {
    if (s.valida) {
      run++;
      if (run > maximoHistorico) maximoHistorico = run;
    } else {
      run = 0;
    }
  }
  // Garante que o atual nunca é maior que histórico (defesa contra
  // edge case onde só a janela corrente é válida).
  if (atual > maximoHistorico) maximoHistorico = atual;

  // Últimas 12 semanas pra UI dot-row no Dashboard.
  const semanasUltimas12 = serie.slice(-12).map((s) => ({
    semana: s.semana,
    valida: s.valida,
    atividades: s.atividades,
  }));

  return { atual, maximoHistorico, semanasUltimas12 };
}

// ─── Helpers ───────────────────────────────────────────────────────

function construirSerieSemanas(n, semanasMap) {
  // Semana corrente alinhada com date_trunc('week', NOW()) = segunda 00:00 UTC.
  const segundaCorrente = inicioSemanaUTC(new Date());
  const serie = [];
  for (let offset = n - 1; offset >= 0; offset--) {
    const data = new Date(segundaCorrente);
    data.setUTCDate(data.getUTCDate() - offset * 7);
    const iso = toISODateOnly(data);
    const atividades = semanasMap.get(iso) ?? 0;
    serie.push({
      semana: iso,
      atividades,
      valida: atividades >= MIN_ATIVIDADES_POR_SEMANA,
    });
  }
  return serie;
}

function inicioSemanaUTC(d) {
  // ISO: segunda = 1, domingo = 7. Date.getUTCDay(): domingo = 0, segunda = 1, ..., sábado = 6.
  // Para alinhar com date_trunc('week') do Postgres (segunda):
  //   diff = (getUTCDay - 1 + 7) % 7
  const day = d.getUTCDay();
  const diff = (day - 1 + 7) % 7;
  const seg = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  seg.setUTCDate(seg.getUTCDate() - diff);
  return seg;
}

function toISODateOnly(d) {
  if (typeof d === 'string') return d.slice(0, 10);
  const date = d instanceof Date ? d : new Date(d);
  return date.toISOString().slice(0, 10);
}

// Constantes exportadas pra testes + reuso no engine.
export const STREAK_CONFIG = Object.freeze({
  JANELA_SEMANAS,
  MIN_ATIVIDADES_POR_SEMANA,
});

// Helpers exportados pra testes diretos.
export const __internal = { construirSerieSemanas, inicioSemanaUTC, toISODateOnly };
