import { prisma } from './prisma.js';

// PR #30 — Fuzzy matching de nomes de exercícios contra o catálogo.
//
// Estratégia: UMA query batched usando UNNEST + LATERAL JOIN. O LLM cospe
// N nomes ("Supino Inclinado com Halteres", "Agachamento Búlgaro", ...);
// devolvemos N matches num único round-trip pro DB.
//
// Thresholds:
//   SQL_THRESHOLD = 0.4 — pre-filtro no SQL pra descartar lixo cedo (ativa
//     o índice GIN trigram). Generoso de propósito; classificação fina vem
//     no app code.
//   APP_GREEN     = 0.9 — match silencioso, sem badge.
//   APP_AMBER     = 0.6 — badge "verificar" no front, coach revisa.
//   abaixo de 0.6 → exercicioId:null + badge vermelho "selecionar manualmente".
//
// Fallback ILIKE: se pg_trgm não estiver disponível (erro com mensagem
// específica), cai num matching degraded por primeira palavra. Score
// artificial 0.5 = sempre laranja. Coach precisa revisar todos.

const SQL_THRESHOLD = 0.4;
const APP_GREEN = 0.9;
const APP_AMBER = 0.6;

/**
 * Match batch de nomes do LLM contra o catálogo.
 *
 * @param {string[]} nomesLlm — nomes brutos vindos do LLM. Pode repetir.
 * @returns {Promise<Array<{
 *   nomeLlm: string,
 *   exercicioId: string|null,
 *   nomeCanonico: string|null,
 *   similarityScore: number,
 *   confianca: 'verde'|'laranja'|'vermelho',
 * }>>}  Array na MESMA ordem e tamanho de `nomesLlm` (repetições preservadas).
 */
export async function matchExerciciosBatch(nomesLlm) {
  if (!Array.isArray(nomesLlm) || nomesLlm.length === 0) return [];

  // Dedupe pra query — preserva ordem do input no return.
  const unique = Array.from(new Set(
    nomesLlm.filter((n) => typeof n === 'string' && n.trim().length > 0),
  ));
  if (unique.length === 0) {
    return nomesLlm.map(nullMatch);
  }

  try {
    const rows = await prisma.$queryRaw`
      SELECT q.nome_llm AS "nomeLlm",
             e.id      AS "exercicioId",
             e.nome    AS "nomeCanonico",
             e.score   AS "similarityScore"
        FROM UNNEST(${unique}::text[]) AS q(nome_llm)
        LEFT JOIN LATERAL (
          SELECT id,
                 nome,
                 similarity(nome, q.nome_llm) AS score
            FROM "Exercicio"
           WHERE similarity(nome, q.nome_llm) >= ${SQL_THRESHOLD}
           ORDER BY similarity(nome, q.nome_llm) DESC
           LIMIT 1
        ) e ON true
    `;

    const map = new Map();
    for (const r of rows) {
      map.set(r.nomeLlm, classify(r));
    }
    return nomesLlm.map((n) => map.get(n) || nullMatch(n));
  } catch (err) {
    if (isPgTrgmMissing(err)) {
      return ilikeFallback(nomesLlm);
    }
    throw err;
  }
}

function classify({ nomeLlm, exercicioId, nomeCanonico, similarityScore }) {
  const score = Number(similarityScore) || 0;
  if (!exercicioId || score < APP_AMBER) {
    return {
      nomeLlm,
      exercicioId: null,
      nomeCanonico: null,
      similarityScore: score,
      confianca: 'vermelho',
    };
  }
  return {
    nomeLlm,
    exercicioId,
    nomeCanonico,
    similarityScore: score,
    confianca: score >= APP_GREEN ? 'verde' : 'laranja',
  };
}

function nullMatch(nomeLlm) {
  return {
    nomeLlm: typeof nomeLlm === 'string' ? nomeLlm : '',
    exercicioId: null,
    nomeCanonico: null,
    similarityScore: 0,
    confianca: 'vermelho',
  };
}

function isPgTrgmMissing(err) {
  const msg = err?.message || '';
  return /pg_trgm|similarity|function .* does not exist/i.test(msg);
}

// Degraded mode: ILIKE pela primeira palavra significativa. Score
// artificial 0.5 marca todos como "laranja" — coach revisa todos.
async function ilikeFallback(nomesLlm) {
  console.warn('[exercicioMatch] pg_trgm indisponível, usando ILIKE fallback (degraded)');
  const unique = Array.from(new Set(
    nomesLlm.filter((n) => typeof n === 'string' && n.trim().length > 0),
  ));

  const results = await Promise.all(unique.map(async (nomeLlm) => {
    const primeiraPalavra = (nomeLlm.trim().split(/\s+/)[0] || '').slice(0, 40);
    if (!primeiraPalavra) return nullMatch(nomeLlm);
    const cands = await prisma.exercicio.findMany({
      where: { nome: { contains: primeiraPalavra, mode: 'insensitive' } },
      select: { id: true, nome: true },
      take: 1,
    });
    if (cands.length === 0) return nullMatch(nomeLlm);
    return {
      nomeLlm,
      exercicioId: cands[0].id,
      nomeCanonico: cands[0].nome,
      similarityScore: 0.5,
      confianca: 'laranja',
    };
  }));

  const map = new Map(results.map((r) => [r.nomeLlm, r]));
  return nomesLlm.map((n) => map.get(n) || nullMatch(n));
}

// Exports pra testes.
export const __internal = { classify, isPgTrgmMissing, APP_GREEN, APP_AMBER, SQL_THRESHOLD };
