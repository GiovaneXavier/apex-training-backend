import { prisma } from '../lib/prisma.js';
import { HttpError } from '../middleware/errorHandler.js';

const DIA_MS = 86400000;

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────

/** Início da semana corrente (segunda 00:00 — padrão BR). */
function inicioSemana(d = new Date()) {
  const date = new Date(d);
  date.setHours(0, 0, 0, 0);
  const dow = date.getDay();              // 0=dom..6=sab
  const diffParaSegunda = (dow + 6) % 7;  // 0→6, 1→0, 2→1...
  date.setDate(date.getDate() - diffParaSegunda);
  return date;
}

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
//    Limita a 2 anos pra evitar loops longos em dados antigos.
// ──────────────────────────────────────────────────────────────
async function calcularStreak(alunoId) {
  let cursor = inicioSemana();
  let semanas = 0;
  for (let i = 0; i < 104; i++) {
    const fim = new Date(cursor);
    fim.setDate(fim.getDate() + 7);
    const [t, a] = await Promise.all([
      prisma.treino.count({
        where: {
          alunoId,
          status: 'CONCLUIDO',
          dataAlvo: { gte: cursor, lt: fim },
        },
      }),
      prisma.atividadeStrava.count({
        where: { alunoId, iniciadoEm: { gte: cursor, lt: fim } },
      }),
    ]);
    if (t === 0 && a === 0) break;
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
// Acesso: mesma regra do treino — aluno só vê seu; prof/nutri
// precisa de vínculo (nutri precisa aceitação para ler? aqui
// dados agregados são só leitura, libera com vínculo apenas).
// ──────────────────────────────────────────────────────────────
async function ensureAccess(user, alunoId) {
  if (user.role === 'ALUNO') {
    const aluno = await prisma.aluno.findUnique({ where: { userId: user.userId } });
    if (!aluno) throw new HttpError(404, 'Perfil de aluno não encontrado');
    if (alunoId && alunoId !== aluno.id) throw new HttpError(403, 'Acesso negado');
    return aluno.id;
  }
  if (!alunoId) throw new HttpError(400, 'alunoId obrigatório');

  if (user.role === 'PROFESSOR') {
    const prof = await prisma.professor.findUnique({ where: { userId: user.userId } });
    if (!prof) throw new HttpError(403, 'Acesso negado');
    const v = await prisma.vinculoProfessor.findUnique({
      where: { alunoId_professorId: { alunoId, professorId: prof.id } },
    });
    if (!v) throw new HttpError(403, 'Aluno não vinculado');
    return alunoId;
  }
  if (user.role === 'NUTRICIONISTA') {
    const nutri = await prisma.nutricionista.findUnique({ where: { userId: user.userId } });
    if (!nutri) throw new HttpError(403, 'Acesso negado');
    const v = await prisma.vinculoNutricionista.findUnique({
      where: { alunoId_nutricionistaId: { alunoId, nutricionistaId: nutri.id } },
    });
    if (!v) throw new HttpError(403, 'Aluno não vinculado');
    return alunoId;
  }
  throw new HttpError(403, 'Acesso negado');
}

// ──────────────────────────────────────────────────────────────
// Endpoint principal
// ──────────────────────────────────────────────────────────────
export async function getDesempenho({ user, alunoId }) {
  const id = await ensureAccess(user, alunoId);
  const [streak, resumoMes, ciclo, estimativasProva] = await Promise.all([
    calcularStreak(id),
    calcularResumoMes(id),
    calcularCiclo(id),
    calcularEstimativasProva(id),
  ]);
  return { streak, resumoMes, ciclo, estimativasProva };
}
