import { prisma } from '../lib/prisma.js';
import { MAX_EXECUCOES_HISTORICO } from '../schemas/aiProgression.schemas.js';

// PR #29 — Coleta histórico set-resolution para o LLM.
//
// Reusa o padrão do `historicoCargas` (PR #7): GIN index seek via @>
// no `Treino.detalhes`. Aqui pegamos as últimas N execuções (não 1),
// e retornamos os arrays de sets completos — não só o último.
//
// Set-resolution permite o LLM detectar drops entre sets (set 1: 8 reps,
// set 3: 5 reps = fadiga real) e RPE crescente — sinais que treino-
// resolution (média) perderia.

/**
 * Histórico cirúrgico de um exercício para um aluno.
 *
 * @param {object} args
 * @param {string} args.alunoId
 * @param {string} args.exercicioNome  Nome canonical (case-sensitive, igual ao gravado em detalhes).
 *
 * @returns {Promise<{
 *   execucoes: Array<{
 *     dataAlvo: string,
 *     sets: Array<{ kg: number|null, reps: number|null, rpe: number|null }>,
 *   }>,
 *   rpeMedioRecente: number|null,
 *   houveFalhaDeReps: boolean,
 *   diasDesdeUltima: number|null,
 * }>}
 */
export async function buildExercicioSnapshot({ alunoId, exercicioNome }) {
  if (!alunoId || !exercicioNome) {
    return emptySnapshot();
  }

  // GIN seek com @> — mesma técnica do historicoCargas, mas LIMIT N.
  const rows = await prisma.$queryRaw`
    SELECT id, "dataAlvo", detalhes
      FROM "Treino"
     WHERE "alunoId" = ${alunoId}
       AND modalidade = 'MUSCULACAO'::"Modalidade"
       AND status IN ('CONCLUIDO'::"StatusTreino", 'EM_EXECUCAO'::"StatusTreino")
       AND detalhes @> ${JSON.stringify({ exercicios: [{ nome: exercicioNome }] })}::jsonb
     ORDER BY "dataAlvo" DESC
     LIMIT ${MAX_EXECUCOES_HISTORICO}
  `;

  const execucoes = [];
  for (const row of rows) {
    const exs = row.detalhes?.exercicios ?? [];
    const ex = exs.find((e) => e.nome === exercicioNome);
    if (!ex) continue;
    const realizado = Array.isArray(ex.realizado) ? ex.realizado : [];
    // Compacta cada set para shape uniforme. Sets vazios (sem kg nem reps)
    // são descartados — não agregam sinal pro LLM.
    const sets = realizado
      .filter((s) => s && (s.kg != null || s.reps != null))
      .map((s) => ({
        kg: typeof s.kg === 'number' ? s.kg : null,
        reps: typeof s.reps === 'number' ? s.reps : null,
        rpe: typeof s.rpe === 'number' ? s.rpe : null,
      }));
    if (sets.length === 0) continue; // só prescrição vazia, sem execução real
    execucoes.push({
      dataAlvo: row.dataAlvo.toISOString(),
      sets,
    });
  }

  if (execucoes.length === 0) return emptySnapshot();

  return {
    execucoes,
    rpeMedioRecente: computeRpeMedioRecente(execucoes[0]),
    houveFalhaDeReps: detectFalhaDeReps(execucoes[0]),
    diasDesdeUltima: computeDiasDesdeUltima(execucoes[0]),
  };
}

function emptySnapshot() {
  return {
    execucoes: [],
    rpeMedioRecente: null,
    houveFalhaDeReps: false,
    diasDesdeUltima: null,
  };
}

// RPE médio da execução MAIS RECENTE. Sinal #1 pro motor de progressão:
//   <= 6  → subir intensidade (regra 3 do system prompt)
//   >= 9  → deload (regra 2)
//   7-8   → manter ou subir volume
function computeRpeMedioRecente(execucao) {
  const valores = execucao.sets
    .map((s) => s.rpe)
    .filter((v) => typeof v === 'number');
  if (valores.length === 0) return null;
  const avg = valores.reduce((a, b) => a + b, 0) / valores.length;
  return Math.round(avg * 10) / 10;
}

// Detecta "drop" de reps entre primeiro e último set >25%. Aluno que
// começou com 10 reps e terminou com 5 falhou na meta — manter carga
// é melhor que subir.
function detectFalhaDeReps(execucao) {
  const reps = execucao.sets.map((s) => s.reps).filter((v) => typeof v === 'number');
  if (reps.length < 2) return false;
  const max = Math.max(...reps);
  const min = Math.min(...reps);
  if (max === 0) return false;
  return (max - min) / max > 0.25;
}

function computeDiasDesdeUltima(execucao) {
  const t = Date.parse(execucao.dataAlvo);
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / 86_400_000);
}

// Resolve o vínculo Aluno → Professor sem chamar resolveAlunoAccess
// (que carrega o Aluno inteiro). Aqui só precisamos saber se o coach
// pode tocar nos dados — booleano. Anti billing-drain: roda ANTES do
// snapshot (que faz $queryRaw) e ANTES da LLM call.
export async function checkProfessorOwnership({ userId, alunoId }) {
  const prof = await prisma.professor.findUnique({
    where: { userId },
    select: { id: true },
  });
  if (!prof) return false;
  const vinculo = await prisma.vinculoProfessor.findUnique({
    where: { alunoId_professorId: { alunoId, professorId: prof.id } },
    select: { id: true },
  });
  return !!vinculo;
}

// Resolve nome encurtado pra LLM (mesma técnica do PR #28 — privacidade).
export async function getNomeAlunoEncurtado(alunoId) {
  const aluno = await prisma.aluno.findUnique({
    where: { id: alunoId },
    select: { user: { select: { nome: true } } },
  });
  if (!aluno) return '—';
  const nome = aluno.user?.nome || '—';
  const parts = nome.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '—';
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
}
