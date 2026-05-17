import { prisma } from '../lib/prisma.js';
import { HttpError } from '../middleware/errorHandler.js';

// ─────────────────────────────────────────────────────────────────────
// Coach Analytics — PR #17
//
// Lista de alertas comportamentais por aluno vinculado ao professor.
// O coração é UM SINGLE round-trip ($queryRaw com CTE encadeada) — o
// objetivo é responder o painel em <100ms mesmo com dezenas de alunos.
//
// Tipos cobertos no MVP (escopo conversado com produto):
//
//   INACTIVE_7D     (high)   — zero atividade (Treino CONCLUIDO OU
//                              AtividadeStrava) nos últimos 7 dias.
//                              Engloba MISSED_WORKOUT: aluno totalmente
//                              parado NÃO recebe alerta dobrado.
//
//   MISSED_WORKOUT  (high)   — Treino PENDENTE com dataAlvo < now-1d.
//                              Cap em 3 mais recentes por aluno pra
//                              não inundar o painel. Excluído se o
//                              aluno está em INACTIVE_7D.
//
//   STREAK_BROKEN   (medium) — teve atividade nas DUAS semanas
//                              anteriores (W-1 e W-2) mas ZERO na
//                              semana corrente. Emite só de quarta em
//                              diante (`isodow >= 3`) — segunda/terça
//                              ainda é cedo demais pra alertar churn.
//
//   MODALIDADE_GAP  (low)    — pra cada (aluno, modalidade), ≥3
//                              atividades nos últimos 60d (sinaliza
//                              hábito) e zero nos últimos 14d.
//                              Detecta o corredor que sumiu da
//                              natação e o levantador que abandonou
//                              o cardio.
//
// O retorno é ordenado por severidade (high > medium > low) e dentro
// de cada grupo, pelo timestamp do evento de origem (mais recente
// primeiro). Cap global de 200 alertas — paginação proper fica pro
// futuro quando começarmos a ver coaches com 100+ alunos.
//
// Strava NÃO mantém ENUM Modalidade. Mapeamos heuristicamente o
// `tipo` (texto da API Strava) pra nosso enum: 'Run'→CORRIDA,
// 'Ride'/'Bike'→CICLISMO, 'Swim'→NATACAO, resto cai em OUTRO. Suficiente
// pra detectar gap por família — não pretendemos refletir 100% do
// Strava aqui.
// ─────────────────────────────────────────────────────────────────────

export async function listAlertasProf({ user }) {
  if (user.role !== 'PROFESSOR') {
    throw new HttpError(403, 'Apenas professores acessam alertas de aderência');
  }
  const prof = await prisma.professor.findUnique({ where: { userId: user.userId } });
  if (!prof) throw new HttpError(404, 'Perfil de professor não encontrado');

  // $queryRaw retorna Date para timestamps; o caller serializa via res.json
  // (ISO 8601). Aliases em snake_case caem como camelCase quando expostos
  // direto (Prisma não converte) — fazemos o map em JS pra controle.
  const rows = await prisma.$queryRaw`
    WITH aluno_vinculo AS (
      SELECT a.id AS aluno_id, u.nome AS aluno_nome
        FROM "VinculoProfessor" vp
        JOIN "Aluno" a ON a.id = vp."alunoId"
        JOIN "User" u  ON u.id = a."userId"
       WHERE vp."professorId" = ${prof.id}
    ),
    -- Timeline unificada de atividades (treino concluído + Strava).
    -- O CASE traduz tipo Strava (texto) pro enum nosso. Filtramos a
    -- janela de 60 dias pra limitar o scan e cobrir todas as métricas
    -- abaixo (a maior janela é 60d em MODALIDADE_GAP).
    treino_atividade AS (
      SELECT "alunoId" AS aluno_id,
             "finalizadoEm" AS quando,
             modalidade::text AS modalidade
        FROM "Treino"
       WHERE status = 'CONCLUIDO'::"StatusTreino"
         AND "finalizadoEm" IS NOT NULL
         AND "finalizadoEm" >= NOW() - INTERVAL '60 days'
         AND "alunoId" IN (SELECT aluno_id FROM aluno_vinculo)
       UNION ALL
      SELECT "alunoId" AS aluno_id,
             "iniciadoEm" AS quando,
             CASE
               WHEN tipo ILIKE 'run%' THEN 'CORRIDA'
               WHEN tipo ILIKE 'ride%' OR tipo ILIKE 'bike%' OR tipo ILIKE 'cycle%' THEN 'CICLISMO'
               WHEN tipo ILIKE 'swim%' THEN 'NATACAO'
               ELSE 'OUTRO'
             END AS modalidade
        FROM "AtividadeStrava"
       WHERE "iniciadoEm" >= NOW() - INTERVAL '60 days'
         AND "alunoId" IN (SELECT aluno_id FROM aluno_vinculo)
    ),
    -- INACTIVE_7D: aluno sem atividade alguma nos últimos 7d. LEFT JOIN
    -- garante que alunos com timeline vazia entram (MAX retorna NULL).
    inactive AS (
      SELECT av.aluno_id, av.aluno_nome, MAX(ta.quando) AS ultima
        FROM aluno_vinculo av
        LEFT JOIN treino_atividade ta ON ta.aluno_id = av.aluno_id
       GROUP BY av.aluno_id, av.aluno_nome
      HAVING MAX(ta.quando) IS NULL
          OR MAX(ta.quando) < NOW() - INTERVAL '7 days'
    ),
    -- MISSED_WORKOUT: PENDENTE com dataAlvo < ontem. ROW_NUMBER limita
    -- a 3 por aluno (mais recentes primeiro) pra não floodar. Exclui
    -- alunos em inactive — alerta dobrado vira ruído.
    missed_raw AS (
      SELECT t.id AS treino_id, t."alunoId" AS aluno_id,
             av.aluno_nome, t.modalidade::text AS modalidade,
             t."dataAlvo" AS quando,
             ROW_NUMBER() OVER (PARTITION BY t."alunoId" ORDER BY t."dataAlvo" DESC) AS rn
        FROM "Treino" t
        JOIN aluno_vinculo av ON av.aluno_id = t."alunoId"
       WHERE t.status = 'PENDENTE'::"StatusTreino"
         AND t."dataAlvo" < NOW() - INTERVAL '1 day'
         AND t."alunoId" NOT IN (SELECT aluno_id FROM inactive)
    ),
    missed AS (SELECT * FROM missed_raw WHERE rn <= 3),
    -- STREAK_BROKEN: tinha atividade nas duas semanas anteriores e
    -- nada na semana corrente. date_trunc('week') no Postgres usa
    -- segunda como início ISO (alinhado com lib/dates.js). Só dispara
    -- de quarta em diante (isodow 3..7).
    streak_broken AS (
      SELECT av.aluno_id, av.aluno_nome
        FROM aluno_vinculo av
       WHERE EXTRACT(ISODOW FROM NOW()) >= 3
         AND av.aluno_id NOT IN (SELECT aluno_id FROM inactive)
         AND EXISTS (
           SELECT 1 FROM treino_atividade
            WHERE aluno_id = av.aluno_id
              AND quando >= date_trunc('week', NOW() - INTERVAL '7 days')
              AND quando <  date_trunc('week', NOW())
         )
         AND EXISTS (
           SELECT 1 FROM treino_atividade
            WHERE aluno_id = av.aluno_id
              AND quando >= date_trunc('week', NOW() - INTERVAL '14 days')
              AND quando <  date_trunc('week', NOW() - INTERVAL '7 days')
         )
         AND NOT EXISTS (
           SELECT 1 FROM treino_atividade
            WHERE aluno_id = av.aluno_id
              AND quando >= date_trunc('week', NOW())
         )
    ),
    -- MODALIDADE_GAP: ≥3 atividades nos 60d e zero nos últimos 14d,
    -- por (aluno, modalidade). Exclui alunos inactive (já têm alerta
    -- maior). MAX(quando) entra na resposta como "última atividade
    -- daquela modalidade".
    mod_stats AS (
      SELECT aluno_id, modalidade,
             COUNT(*) AS cnt_60d,
             MAX(quando) AS ultima
        FROM treino_atividade
       GROUP BY aluno_id, modalidade
    ),
    gap AS (
      SELECT ms.aluno_id, av.aluno_nome, ms.modalidade, ms.ultima
        FROM mod_stats ms
        JOIN aluno_vinculo av ON av.aluno_id = ms.aluno_id
       WHERE ms.cnt_60d >= 3
         AND ms.ultima < NOW() - INTERVAL '14 days'
         AND ms.aluno_id NOT IN (SELECT aluno_id FROM inactive)
    )
    -- Emissão final unificada. severidade vira ordem numérica
    -- pra ordenação determinística (high=1 < medium=2 < low=3).
    SELECT * FROM (
      SELECT 'INACTIVE_7D'    AS tipo, 1 AS sev,
             aluno_id, aluno_nome, NULL::text AS treino_id, NULL::text AS modalidade,
             ultima AS quando
        FROM inactive
      UNION ALL
      SELECT 'MISSED_WORKOUT', 1,
             aluno_id, aluno_nome, treino_id, modalidade, quando
        FROM missed
      UNION ALL
      SELECT 'STREAK_BROKEN', 2,
             aluno_id, aluno_nome, NULL, NULL, NULL::timestamp
        FROM streak_broken
      UNION ALL
      SELECT 'MODALIDADE_GAP', 3,
             aluno_id, aluno_nome, NULL, modalidade, ultima
        FROM gap
    ) AS combined
    ORDER BY sev ASC, quando DESC NULLS LAST
    LIMIT 200
  `;

  return rows.map(toAlerta);
}

const SEVERIDADE = {
  INACTIVE_7D: 'high',
  MISSED_WORKOUT: 'high',
  STREAK_BROKEN: 'medium',
  MODALIDADE_GAP: 'low',
};

const MODALIDADE_LABEL_PT = {
  MUSCULACAO: 'musculação',
  CORRIDA: 'corrida',
  CICLISMO: 'ciclismo',
  NATACAO: 'natação',
  HYROX: 'hyrox',
  TRIATHLON: 'triathlon',
  OUTRO: 'treino',
};

function toAlerta(row) {
  // Prisma raw devolve as colunas em lowercase do alias SQL.
  const tipo = row.tipo;
  const aluno_id = row.aluno_id;
  const aluno_nome = row.aluno_nome;
  const treino_id = row.treino_id ?? undefined;
  const modalidade = row.modalidade ?? undefined;
  const quando = row.quando ? new Date(row.quando).toISOString() : null;

  return {
    alunoId: aluno_id,
    alunoNome: aluno_nome,
    tipo,
    severidade: SEVERIDADE[tipo] ?? 'low',
    detalhe: detalhar(tipo, modalidade, quando),
    modalidade,
    treinoId: treino_id,
    desde: quando,
  };
}

function detalhar(tipo, modalidade, quando) {
  const dias = quando ? Math.floor((Date.now() - new Date(quando).getTime()) / 86_400_000) : null;
  const modLabel = modalidade ? (MODALIDADE_LABEL_PT[modalidade] ?? 'treino') : null;

  switch (tipo) {
    case 'INACTIVE_7D':
      return quando
        ? `Sem atividade há ${dias} dias`
        : 'Nunca registrou atividade';
    case 'MISSED_WORKOUT':
      return modLabel
        ? `Faltou ${modLabel} (${dias}d atrás)`
        : `Treino pendente há ${dias}d`;
    case 'STREAK_BROKEN':
      return 'Quebrou streak — semana atual sem atividade';
    case 'MODALIDADE_GAP':
      return modLabel
        ? `Sem ${modLabel} há ${dias} dias`
        : `Modalidade pausada há ${dias}d`;
    default:
      return tipo;
  }
}
