import { prisma } from '../lib/prisma.js';
import { resolveAlunoAccess } from '../lib/access.js';
import { HttpError } from '../middleware/errorHandler.js';
import { inicioSemana } from '../lib/dates.js';

const DIA_MS = 86400000;

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────
// `inicioSemana` agora vem de lib/dates.js (PR #14, audit 4.18).
// `inicioSemanaUTC` abaixo permanece local — é detalhe do cálculo
// de streak que precisa rodar em UTC para ser TZ-agnóstico.

function inicioMes(d = new Date()) {
  return new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0);
}
function fimMes(d = new Date()) {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
}

function fmtTempo(seg) {
  if (!Number.isFinite(seg) || seg <= 0) return null;
  if (seg < 3600) {
    const m = Math.floor(seg / 60);
    const s = Math.round(seg % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }
  const h = Math.floor(seg / 3600);
  const m = Math.floor((seg % 3600) / 60);
  const s = Math.round(seg % 60);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function fmtPaceSegPorKm(segPorKm) {
  if (!Number.isFinite(segPorKm) || segPorKm <= 0) return null;
  const m = Math.floor(segPorKm / 60);
  const s = Math.round(segPorKm % 60);
  return `${m}:${String(s).padStart(2, '0')} /km`;
}

function fmtTempoMin(min) {
  if (!Number.isFinite(min) || min <= 0) return '0min';
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (h === 0) return `${m}min`;
  return `${h}h ${String(m).padStart(2, '0')}min`;
}

// ──────────────────────────────────────────────────────────────
// 1. STREAK — semanas consecutivas com pelo menos 1 atividade
//    Atividade = Treino concluído OU AtividadeStrava registrada.
//
// Antes (PR pré-#7): 208 round-trips (104 semanas × 2 counts seriais)
//   no pior caso. Dashboard piscava em ~1-2s pra atleta veterano.
//
// Agora: 1 SQL UNION + GROUP BY date_trunc('week') retorna no máximo
//   ~104 linhas com a coluna `week` em texto YYYY-MM-DD. JS faz lookup
//   O(1) num Set e conta consecutivas a partir da semana corrente.
//
// TZ note: comparamos em UTC (cursor via getUTC* + to_char no Postgres)
//   pra eliminar drift entre server-local e UTC do DB. Em prod (Render
//   UTC) é no-op; em dev BRT corrige off-by-3h em treinos late-Sunday.
// ──────────────────────────────────────────────────────────────

function inicioSemanaUTC(d = new Date()) {
  const date = new Date(d);
  date.setUTCHours(0, 0, 0, 0);
  const dow = date.getUTCDay();              // 0=dom..6=sab
  const diffParaSegunda = (dow + 6) % 7;
  date.setUTCDate(date.getUTCDate() - diffParaSegunda);
  return date;
}

function isoDateUTC(d) {
  return d.toISOString().slice(0, 10);       // 'YYYY-MM-DD'
}

async function calcularStreak(alunoId) {
  const inicio = inicioSemanaUTC();
  const limite = new Date(inicio);
  limite.setUTCDate(limite.getUTCDate() - 104 * 7);

  // UNION ALL: cada fonte filtra alunoId+janela ANTES do union, então
  // o planner usa os índices (alunoId, dataAlvo) e (alunoId, iniciadoEm).
  // GROUP BY no date_trunc deduplica semanas. to_char emite YYYY-MM-DD
  // pra comparação por string (TZ-agnóstico) no JS.
  const rows = await prisma.$queryRaw`
    SELECT to_char(date_trunc('week', d), 'YYYY-MM-DD') AS week
    FROM (
      SELECT "dataAlvo" AS d
        FROM "Treino"
       WHERE "alunoId" = ${alunoId}
         AND status = 'CONCLUIDO'::"StatusTreino"
         AND "dataAlvo" >= ${limite}
      UNION ALL
      SELECT "iniciadoEm" AS d
        FROM "AtividadeStrava"
       WHERE "alunoId" = ${alunoId}
         AND "iniciadoEm" >= ${limite}
    ) src
    GROUP BY date_trunc('week', d)
  `;

  const ativas = new Set(rows.map((r) => r.week));

  let cursor = inicio;
  let semanas = 0;
  for (let i = 0; i < 104; i++) {
    if (!ativas.has(isoDateUTC(cursor))) break;
    semanas++;
    cursor = new Date(cursor.getTime() - 7 * DIA_MS);
  }
  return semanas;
}

// ──────────────────────────────────────────────────────────────
// 2. RESUMO DO MÊS — agrega Treino + AtividadeStrava do mês corrente
//    Distância: soma do JSON detalhes.realizado.distanciaKm de Treino
//      + AtividadeStrava.distanciaM (convertido)
//    Tempo: finalizadoEm-iniciadoEm dos treinos + AtividadeStrava.duracaoSeg
//    Carga: somatório (kg × reps) dos sets de musculação concluída
// ──────────────────────────────────────────────────────────────
async function calcularResumoMes(alunoId) {
  const ini = inicioMes();
  const fim = fimMes();

  const [treinos, atividades] = await Promise.all([
    prisma.treino.findMany({
      where: { alunoId, status: 'CONCLUIDO', dataAlvo: { gte: ini, lte: fim } },
      select: {
        id: true, modalidade: true, detalhes: true,
        iniciadoEm: true, finalizadoEm: true, dataAlvo: true,
      },
    }),
    prisma.atividadeStrava.findMany({
      where: { alunoId, iniciadoEm: { gte: ini, lte: fim } },
      select: { distanciaM: true, duracaoSeg: true },
    }),
  ]);

  let distanciaKm = 0;
  let tempoSeg = 0;
  let cargaTotalKg = 0;

  for (const t of treinos) {
    const d = t.detalhes ?? {};
    // Distância — corrida e ciclismo
    const distanciaJson =
      d?.realizado?.distanciaKm ??
      d?.distanciaKm ??
      null;
    if (typeof distanciaJson === 'number') distanciaKm += distanciaJson;

    // Tempo — preferir realizado.duracaoSeg, depois iniciadoEm/finalizadoEm
    const duracaoJson = d?.realizado?.duracaoSeg;
    if (typeof duracaoJson === 'number') {
      tempoSeg += duracaoJson;
    } else if (t.iniciadoEm && t.finalizadoEm) {
      tempoSeg += Math.max(0, (new Date(t.finalizadoEm).getTime() - new Date(t.iniciadoEm).getTime()) / 1000);
    }

    // Carga em musculação: kg × reps por set realizado
    if (d?.tipo === 'musculacao' && Array.isArray(d.exercicios)) {
      for (const ex of d.exercicios) {
        const sets = Array.isArray(ex.realizado) ? ex.realizado : [];
        for (const s of sets) {
          const kg = Number(s?.kg);
          const reps = Number(s?.reps);
          if (Number.isFinite(kg) && Number.isFinite(reps) && kg > 0 && reps > 0) {
            cargaTotalKg += kg * reps;
          }
        }
      }
    }
  }

  for (const a of atividades) {
    distanciaKm += (a.distanciaM ?? 0) / 1000;
    tempoSeg += a.duracaoSeg ?? 0;
  }

  const tempoMin = Math.round(tempoSeg / 60);

  return {
    treinos: treinos.length,
    atividadesStrava: atividades.length,
    distanciaKm: Number(distanciaKm.toFixed(1)),
    tempoMin,
    tempoFmt: fmtTempoMin(tempoMin),
    cargaTotalKg: Math.round(cargaTotalKg),
  };
}

// ──────────────────────────────────────────────────────────────
// 3. CICLO — % conclusão de treinos do mês
//    Estratégia: pegar todos os Treinos do mês corrente e calcular
//    concluídos / total. Se o aluno tem rotina semanal vigente,
//    inclui o nome no metaTitulo. Caso contrário, "Treinos do mês".
// ──────────────────────────────────────────────────────────────
async function calcularCiclo(alunoId) {
  const ini = inicioMes();
  const fim = fimMes();

  const [treinosMes, rotinaVigente] = await Promise.all([
    prisma.treino.findMany({
      where: { alunoId, dataAlvo: { gte: ini, lte: fim } },
      select: { status: true, modalidade: true, detalhes: true },
    }),
    prisma.rotinaMusculacao.findFirst({
      where: {
        alunoId,
        vigenciaInicio: { lte: new Date() },
        OR: [{ vigenciaFim: null }, { vigenciaFim: { gte: new Date() } }],
      },
      orderBy: { criadoEm: 'desc' },
      select: { nome: true, diaSemana: true },
    }),
  ]);

  const total = treinosMes.length;
  const concluidos = treinosMes.filter((t) => t.status === 'CONCLUIDO').length;
  const pct = total === 0 ? 0 : Math.round((concluidos / total) * 100);

  // Distância acumulada do mês — corrida/ciclismo somado
  let distanciaKm = 0;
  for (const t of treinosMes) {
    if (t.status !== 'CONCLUIDO') continue;
    const d = t.detalhes ?? {};
    const dist = d?.realizado?.distanciaKm ?? d?.distanciaKm;
    if (typeof dist === 'number') distanciaKm += dist;
  }

  return {
    pct,
    concluidos,
    total,
    metaTitulo: rotinaVigente?.nome ?? 'Treinos do mês',
    distanciaKm: Number(distanciaKm.toFixed(1)),
  };
}

// ──────────────────────────────────────────────────────────────
// 4. ESTIMATIVAS DE PROVA — RPs de corrida convertidos em pace
//    Distâncias padrão: 5K, 10K, 15K, 21K. Para cada uma, procura
//    RecordePessoal de modalidade CORRIDA com `exercicio` casando
//    (case-insensitive: "5km", "5K", "5 km", "21K", etc).
//    Se nenhuma distância tiver RP, devolve null (front mostra empty).
// ──────────────────────────────────────────────────────────────
const DISTANCIAS = [
  { rotulo: '5K',  km: 5,  regex: /^\s*5\s*(k|km)\s*$/i },
  { rotulo: '10K', km: 10, regex: /^\s*10\s*(k|km)\s*$/i },
  { rotulo: '15K', km: 15, regex: /^\s*15\s*(k|km)\s*$/i },
  { rotulo: '21K', km: 21, regex: /^\s*21\s*(k|km)\s*$/i },
];

async function calcularEstimativasProva(alunoId) {
  const rps = await prisma.recordePessoal.findMany({
    where: { alunoId, modalidade: 'CORRIDA', metrica: 'tempo' },
    orderBy: { dataRecorde: 'desc' },
    select: { exercicio: true, valor: true, unidade: true, dataRecorde: true },
  });

  const out = DISTANCIAS.map((d) => {
    const rp = rps.find((r) => d.regex.test(r.exercicio));
    if (!rp) return { prova: d.rotulo, tempo: null, pace: null };
    // Suporta unidade 's' (segundos). Outras unidades: tenta fallback.
    const seg = rp.unidade === 's' ? rp.valor : rp.unidade === 'min' ? rp.valor * 60 : rp.valor;
    return {
      prova: d.rotulo,
      tempo: fmtTempo(seg),
      pace: fmtPaceSegPorKm(seg / d.km),
    };
  });

  // Se nenhum RP — retorna null para o front exibir empty state.
  if (out.every((e) => e.tempo === null)) return null;
  return out;
}

// ──────────────────────────────────────────────────────────────
// Endpoint principal
//
// Acesso via guardião canônico (../lib/access.js). Mudança importante
// no PR #4.1: a cópia local `ensureAccess` permitia que NUTRI sem
// `aceitoPeloAluno === true` visualizasse dados agregados. Agora,
// estatísticas são tratadas como qualquer outro dado do aluno — exigem
// aceite. Read-only, então `write` fica false (default).
// ──────────────────────────────────────────────────────────────
export async function getDesempenho({ user, alunoId }) {
  const aluno = await resolveAlunoAccess({ user, alunoId });
  const id = aluno.id;
  const [streak, resumoMes, ciclo, estimativasProva] = await Promise.all([
    calcularStreak(id),
    calcularResumoMes(id),
    calcularCiclo(id),
    calcularEstimativasProva(id),
  ]);
  return { streak, resumoMes, ciclo, estimativasProva };
}

// ──────────────────────────────────────────────────────────────
// PR #20 — Matriz de Volume Semanal
//
// Série temporal de volume por modalidade para o gráfico do atleta.
// Single round-trip com timeline unificada (Treino concluído + Strava)
// agrupada por week via date_trunc — o mesmo padrão arquitetural do
// PR #17 (Coach Analytics).
//
// Unidades por modalidade (escolha deliberada — cada modalidade
// "mede progresso" diferente):
//
//   - corridaKm    → distância (Km)        ← Treino.realizado.distanciaKm
//                                            + Strava Run distanciaM/1000
//   - ciclismoKm   → distância (Km)        ← idem
//   - natacaoM     → distância (metros)    ← Treino.realizado.distanciaTotalM
//                                            + Strava Swim distanciaM
//   - musculacaoKg → TONELAGEM (Σ kg × reps de todos os sets concluídos)
//
// Por que metros em natação e km nas outras: piscina é dimensionada
// em metros (200m, 1500m). Já corredor pensa em "10km, meia-maratona".
// Ciclista pensa em km. UI traduz cada eixo Y conforme o modo.
//
// Tonelagem de musculação: aprofundamos no jsonb com 2 LATERAL JOINs
// (exercicios → realizado → sets). Filtramos linhas onde `kg` ou
// `reps` são nulos (warm-up sem carga registrada, etc) — soma só o
// que tem valor numérico real.
//
// Janela: 4-52 semanas (cap pelo schema). Default 12 (3 meses) — o
// horizonte onde dá pra ver bloco de treino completo sem inflar payload.
// ──────────────────────────────────────────────────────────────

export async function getVolumeSeries({ user, alunoId, weeks = 12 }) {
  const aluno = await resolveAlunoAccess({ user, alunoId });
  const id = aluno.id;

  const semanas = Math.max(4, Math.min(weeks, 52));

  // Cursor de início = começo da semana corrente − (semanas-1) * 7d, em UTC.
  // Math: queremos N semanas TOTAIS (incluindo a atual), então recuamos N-1.
  const inicio = inicioSemanaUTC();
  inicio.setUTCDate(inicio.getUTCDate() - (semanas - 1) * 7);

  // Timeline unificada com colunas SEMÂNTICAS por modalidade. Cada
  // linha contribui pra UMA modalidade (zeros nas outras), e a agregação
  // final faz SUM por semana. Postgres otimiza o UNION ALL usando os
  // índices (alunoId, dataAlvo/finalizadoEm/iniciadoEm) que já existem.
  //
  // Strava swim usa distanciaM como metros (sem dividir por 1000);
  // outras modalidades Strava dividem pra ter km coerente com Treino.realizado.
  const rows = await prisma.$queryRaw`
    WITH timeline AS (
      -- Treino CORRIDA / CICLISMO: km vem do realizado.distanciaKm
      SELECT t."finalizadoEm" AS quando,
             t.modalidade::text AS modalidade,
             COALESCE((t.detalhes->'realizado'->>'distanciaKm')::float, 0) AS km,
             0::float AS metros,
             0::float AS tonelagem
        FROM "Treino" t
       WHERE t."alunoId" = ${id}
         AND t.status = 'CONCLUIDO'::"StatusTreino"
         AND t."finalizadoEm" >= ${inicio}
         AND t.modalidade IN ('CORRIDA'::"Modalidade", 'CICLISMO'::"Modalidade")
      UNION ALL
      -- Treino NATAÇÃO: metros vêm do realizado.distanciaTotalM
      SELECT t."finalizadoEm",
             'NATACAO',
             0,
             COALESCE((t.detalhes->'realizado'->>'distanciaTotalM')::float, 0),
             0
        FROM "Treino" t
       WHERE t."alunoId" = ${id}
         AND t.status = 'CONCLUIDO'::"StatusTreino"
         AND t."finalizadoEm" >= ${inicio}
         AND t.modalidade = 'NATACAO'::"Modalidade"
      UNION ALL
      -- Treino MUSCULAÇÃO: tonelagem agregada via jsonb (2 LATERAL JOINs).
      -- Subselect SUM por treino — depois somamos por semana lá embaixo.
      SELECT t."finalizadoEm",
             'MUSCULACAO',
             0, 0,
             COALESCE((
               SELECT SUM((s->>'kg')::float * (s->>'reps')::float)
                 FROM jsonb_array_elements(t.detalhes->'exercicios') AS ex,
                      jsonb_array_elements(ex->'realizado') AS s
                WHERE (s->>'kg')   ~ '^[0-9]+(\\.[0-9]+)?$'
                  AND (s->>'reps') ~ '^[0-9]+(\\.[0-9]+)?$'
             ), 0)
        FROM "Treino" t
       WHERE t."alunoId" = ${id}
         AND t.status = 'CONCLUIDO'::"StatusTreino"
         AND t."finalizadoEm" >= ${inicio}
         AND t.modalidade = 'MUSCULACAO'::"Modalidade"
      UNION ALL
      -- Strava: classifica pelo campo "tipo" (texto). Run/Ride em km;
      -- Swim em metros. Resto cai em OUTRO e contribui zero.
      SELECT a."iniciadoEm",
             CASE
               WHEN a.tipo ILIKE 'run%' THEN 'CORRIDA'
               WHEN a.tipo ILIKE 'ride%' OR a.tipo ILIKE 'bike%' OR a.tipo ILIKE 'cycle%' THEN 'CICLISMO'
               WHEN a.tipo ILIKE 'swim%' THEN 'NATACAO'
               ELSE 'OUTRO'
             END,
             CASE WHEN a.tipo ILIKE 'swim%' THEN 0 ELSE (a."distanciaM" / 1000.0) END,
             CASE WHEN a.tipo ILIKE 'swim%' THEN a."distanciaM"::float ELSE 0 END,
             0
        FROM "AtividadeStrava" a
       WHERE a."alunoId" = ${id}
         AND a."iniciadoEm" >= ${inicio}
    )
    SELECT
      to_char(date_trunc('week', quando), 'YYYY-MM-DD') AS semana,
      SUM(CASE WHEN modalidade = 'CORRIDA'    THEN km       ELSE 0 END) AS corrida_km,
      SUM(CASE WHEN modalidade = 'CICLISMO'   THEN km       ELSE 0 END) AS ciclismo_km,
      SUM(CASE WHEN modalidade = 'NATACAO'    THEN metros   ELSE 0 END) AS natacao_m,
      SUM(CASE WHEN modalidade = 'MUSCULACAO' THEN tonelagem ELSE 0 END) AS musculacao_kg
    FROM timeline
    GROUP BY semana
    ORDER BY semana ASC
  `;

  // Pós-processo: o SQL retorna SÓ semanas que tiveram atividade
  // (`GROUP BY`). Pro gráfico sem "buracos", preenchemos as semanas
  // vazias da janela com zeros — JS é mais simples que generate_series.
  const indexada = new Map(rows.map((r) => [r.semana, r]));
  const series = [];
  const cursor = new Date(inicio);
  for (let i = 0; i < semanas; i++) {
    const key = cursor.toISOString().slice(0, 10);
    const r = indexada.get(key);
    series.push({
      semana: key,
      corridaKm:    r ? Number(r.corrida_km)    : 0,
      ciclismoKm:   r ? Number(r.ciclismo_km)   : 0,
      natacaoM:     r ? Number(r.natacao_m)     : 0,
      musculacaoKg: r ? Number(r.musculacao_kg) : 0,
    });
    cursor.setUTCDate(cursor.getUTCDate() + 7);
  }
  return { weeks: semanas, series };
}
