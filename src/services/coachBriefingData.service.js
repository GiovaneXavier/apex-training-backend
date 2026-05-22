import { prisma } from '../lib/prisma.js';
import { listAlertasProf } from './coach.service.js';
import { MAX_ALUNOS_NO_PROMPT } from '../schemas/coachBriefing.schemas.js';

// PR #28 — Agregador de snapshot pro Coach Briefing.
//
// RESPONSABILIDADE ÚNICA: montar a fotografia compacta dos alunos
// vinculados que vai virar input do LLM. Não chama IA. Não persiste.
//
// REUSO: `listAlertasProf` já faz o heavy-lifting analítico (CTE única
// cobrindo INACTIVE_7D / MISSED_WORKOUT / STREAK_BROKEN / MODALIDADE_GAP).
// Aqui apenas agrupa por aluno e enriquece com metadata leve (modalidades
// ativas, plano alimentar, prova alvo).
//
// CAP de 50 alunos no prompt: orçamento de tokens controlado mesmo pra
// coach com assessoria grande. Os excedentes (sem sinal de alerta) viram
// contagem agregada — LLM sabe que existem mas não enumera.

/**
 * Coleta snapshot pra um Professor.
 *
 * @param {object} args
 * @param {string} args.userId   userId do Professor logado.
 *
 * @returns {Promise<{
 *   professorId: string,
 *   snapshots: Array<object>,
 *   alunosVinculadosTotal: number,
 *   alunosSemSnapshotResidual: number,
 *   alunoIdsAutorizados: Set<string>,
 * }>}
 */
export async function buildBriefingSnapshot({ userId }) {
  const prof = await prisma.professor.findUnique({
    where: { userId },
    select: { id: true },
  });
  if (!prof) {
    return {
      professorId: null,
      snapshots: [],
      alunosVinculadosTotal: 0,
      alunosSemSnapshotResidual: 0,
      alunoIdsAutorizados: new Set(),
    };
  }

  // Lista alunos vinculados — base do "alunoIdsAutorizados" pra fence
  // pós-LLM. Sem ele, LLM poderia alucinar IDs e o serviço aceitaria.
  const vinculos = await prisma.vinculoProfessor.findMany({
    where: { professorId: prof.id },
    select: {
      aluno: {
        select: {
          id: true,
          user: { select: { nome: true } },
          provas: {
            select: { nome: true, data: true },
            orderBy: { data: 'asc' },
          },
          planos: {
            where: { ativo: true },
            select: { id: true },
            take: 1,
          },
          treinos: {
            where: {
              status: { in: ['CONCLUIDO', 'EM_EXECUCAO'] },
              finalizadoEm: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
            },
            select: { modalidade: true },
            // 30 últimos treinos cobre todas as modalidades sem inflar.
            take: 30,
            orderBy: { finalizadoEm: 'desc' },
          },
        },
      },
    },
  });

  const alunoIdsAutorizados = new Set(vinculos.map((v) => v.aluno.id));

  // Alertas via service existente (single round-trip).
  // Wrap pra não derrubar o briefing se a query analítica falhar.
  let alertas = [];
  try {
    alertas = await listAlertasProf({ user: { userId, role: 'PROFESSOR' } });
  } catch (err) {
    console.warn('[coachBriefingData] listAlertasProf falhou', err?.message);
  }

  // Agrupa alertas por aluno (max 5 por aluno pra não inflar prompt).
  const alertasPorAluno = new Map();
  for (const a of alertas) {
    if (!alunoIdsAutorizados.has(a.alunoId)) continue; // sanity
    if (!alertasPorAluno.has(a.alunoId)) alertasPorAluno.set(a.alunoId, []);
    const list = alertasPorAluno.get(a.alunoId);
    if (list.length < 5) list.push({
      tipo: a.tipo,
      severidade: a.severidade,
      detalhe: a.detalhe,
      desde: a.desde,
    });
  }

  // Constrói snapshots: ordena alunos com alerta primeiro (severidade
  // alta no topo), depois alunos sem alerta. Aplica cap MAX_ALUNOS_NO_PROMPT.
  const snapshots = vinculos.map((v) => {
    const aluno = v.aluno;
    const modalidadesAtivas = Array.from(new Set(aluno.treinos.map((t) => t.modalidade)));
    const proxProva = pickProvaFutura(aluno.provas);
    const alertasAluno = alertasPorAluno.get(aluno.id) ?? [];
    return {
      alunoId: aluno.id,
      nome: encurtarNome(aluno.user?.nome ?? '—'),
      modalidadesAtivas,
      alertas: alertasAluno,
      planoAlimentarAtivo: (aluno.planos?.length ?? 0) > 0,
      proxProva,
      _temAlerta: alertasAluno.length > 0,
      _maxSev: maxSeveridade(alertasAluno),
    };
  });

  // Ordenação: com-alerta(high>medium>low) → sem-alerta. Estável quando
  // empate em severidade.
  const SEV_ORDER = { high: 0, medium: 1, low: 2 };
  snapshots.sort((a, b) => {
    if (a._temAlerta !== b._temAlerta) return a._temAlerta ? -1 : 1;
    return (SEV_ORDER[a._maxSev] ?? 3) - (SEV_ORDER[b._maxSev] ?? 3);
  });

  const capped = snapshots.slice(0, MAX_ALUNOS_NO_PROMPT);
  // Limpa props internas antes de devolver.
  for (const s of capped) {
    delete s._temAlerta;
    delete s._maxSev;
  }

  return {
    professorId: prof.id,
    snapshots: capped,
    alunosVinculadosTotal: vinculos.length,
    alunosSemSnapshotResidual: Math.max(0, vinculos.length - capped.length),
    alunoIdsAutorizados,
  };
}

function encurtarNome(nome) {
  // Privacidade: enviamos primeiro nome + inicial do último sobrenome.
  // Suficiente pro coach identificar, reduz exposição a LLM.
  const parts = String(nome).trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '—';
  if (parts.length === 1) return parts[0];
  const first = parts[0];
  const last = parts[parts.length - 1];
  return `${first} ${last[0].toUpperCase()}.`;
}

function pickProvaFutura(provas) {
  if (!Array.isArray(provas) || provas.length === 0) return null;
  const now = Date.now();
  const futuras = provas
    .filter((p) => p.data && new Date(p.data).getTime() > now)
    .sort((a, b) => new Date(a.data) - new Date(b.data));
  if (futuras.length === 0) return null;
  const p = futuras[0];
  const diasAte = Math.ceil((new Date(p.data).getTime() - now) / 86_400_000);
  return {
    nome: p.nome,
    dataAlvo: new Date(p.data).toISOString().slice(0, 10),
    diasAte,
  };
}

function maxSeveridade(alertas) {
  if (!alertas.length) return null;
  if (alertas.some((a) => a.severidade === 'high')) return 'high';
  if (alertas.some((a) => a.severidade === 'medium')) return 'medium';
  return 'low';
}
