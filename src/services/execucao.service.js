import { prisma } from '../lib/prisma.js';
import { HttpError } from '../middleware/errorHandler.js';
import { getRealizadoSchemaPorTipo } from '../schemas/execucao.schemas.js';
import { firePush, payloadNovoRecorde } from '../lib/pushTriggers.js';
import { avaliarConquistas } from '../lib/conquistasEngine.js';

// Salva execução do aluno + detecta novos RPs (musculação por (exercicio, reps)).
// Retorna { treino, novosRecordes }.
export async function salvarExecucao({ user, treinoId, input }) {
  if (user.role !== 'ALUNO') throw new HttpError(403, 'Apenas alunos podem registrar execução');

  const aluno = await prisma.aluno.findUnique({ where: { userId: user.userId } });
  if (!aluno) throw new HttpError(404, 'Perfil de aluno não encontrado');

  const treino = await prisma.treino.findUnique({ where: { id: treinoId } });
  if (!treino) throw new HttpError(404, 'Treino não encontrado');
  if (treino.alunoId !== aluno.id) throw new HttpError(403, 'Treino de outro aluno');

  // PR #11 — validação dinâmica por modalidade. O controller já passou
  // pelo `salvarExecucaoSchema` (estrutura, caps de DoS), mas o formato
  // do `realizado` depende do `tipo` gravado em detalhes — só conseguimos
  // checar AGORA, depois de carregar o treino. Esta segunda passada é
  // .strict(): qualquer campo desconhecido vira 400 em vez de poluir o
  // jsonb com dados arbitrários ("storage poisoning").
  const sanitized = validarPorModalidade(treino.detalhes, input);

  // Merge realizado nos detalhes JSON
  const detalhes = mergeRealizado(treino.detalhes, sanitized);

  // Detecta novos RPs (apenas musculação por enquanto)
  const novosRecordes = [];
  if (detalhes?.tipo === 'musculacao' && Array.isArray(detalhes.exercicios)) {
    const grupos = new Map(); // chave: `${exercicio}|${reps}` → maxKg
    for (const ex of detalhes.exercicios) {
      if (!Array.isArray(ex.realizado)) continue;
      for (const set of ex.realizado) {
        const kg = Number(set?.kg);
        const reps = Number(set?.reps);
        if (!kg || !reps) continue;
        const k = `${ex.nome}|${reps}`;
        if (!grupos.has(k) || grupos.get(k).kg < kg) {
          grupos.set(k, { kg, reps, exercicio: ex.nome });
        }
      }
    }

    for (const [, g] of grupos) {
      const novo = await aplicarRecorde({
        alunoId: aluno.id,
        exercicio: g.exercicio,
        reps: g.reps,
        kg: g.kg,
        treinoId,
      });
      if (novo) novosRecordes.push(novo);
    }
  }

  // PR #19 — Sala de Troféus Endurance.
  //
  // Detecta se o treino foi de CORRIDA com distância canônica
  // (5K/10K/21.1K/42.2K, tolerância ±200m por bucket) e gera/atualiza
  // RP de pace. Lower-is-better — quanto MENOR o pace, melhor a marca.
  //
  // Strava não vira RP por aqui — atividades importadas vivem em
  // AtividadeStrava e não passam por `salvarExecucao`. Pace por
  // Strava fica como upgrade futuro (`strava.service` chamando o
  // mesmo `aplicarRecordePace`).
  if (detalhes?.tipo === 'corrida' && detalhes.realizado) {
    const km = Number(detalhes.realizado.distanciaKm);
    const seg = Number(detalhes.realizado.duracaoSeg);
    if (km > 0 && seg > 0) {
      const bucket = detectarDistanciaCanonica(km);
      if (bucket) {
        // segPorKm é o valor armazenado. O ratio (duracao em min / km)
        // dá min/km, mas guardamos em SEGUNDOS pra precisão integer-ish.
        // UI traduz pra MM:SS pra display.
        const segPorKm = seg / km;
        const novo = await aplicarRecordePace({
          alunoId: aluno.id,
          exercicio: bucket.exercicio,
          segPorKm,
          treinoId,
        });
        if (novo) novosRecordes.push(novo);
      }
    }
  }

  const updated = await prisma.treino.update({
    where: { id: treinoId },
    data: {
      detalhes,
      status: sanitized.status ?? 'CONCLUIDO',
      finalizadoEm: sanitized.finalizadoEm ? new Date(sanitized.finalizadoEm) : new Date(),
    },
  });

  // PR #27 — Gatilho da Glória. ALUNO bate RP, ALUNO recebe push (própria
  // user.userId — sem lookup extra).
  // Anti-flood: payloadNovoRecorde agrega quando há >1 RP no mesmo treino.
  // Retorna null se array vazio → firePush(null userId) é no-op silencioso.
  const rpPayload = payloadNovoRecorde(novosRecordes);
  if (rpPayload) {
    firePush({
      userId: user.userId,
      payload: rpPayload,
      trigger: 'novo-recorde',
    });
  }

  // PR #31 — Conquistas (Sprint 11). 3 triggers em paralelo, todos
  // fire-and-forget pelo engine. Conquista falhar NUNCA derruba o
  // salvarExecucao (try/catch dentro do engine + queueMicrotask).
  queueMicrotask(() => {
    // STREAK reavalia em todo treino concluído — barato e cobre quem
    // fechou a meta semanal exatamente agora.
    void avaliarConquistas({
      alunoId: aluno.id,
      trigger: 'STREAK',
      contexto: { treinoId },
    });
    // RP_FIRST + PACE_THRESHOLD: só faz sentido se houve RP novo.
    if (novosRecordes.length > 0) {
      void avaliarConquistas({
        alunoId: aluno.id,
        trigger: 'RP_FIRST',
        contexto: { novosRecordes, treinoId },
      });
      void avaliarConquistas({
        alunoId: aluno.id,
        trigger: 'PACE_THRESHOLD',
        contexto: { novosRecordes, treinoId },
      });
    }
  });

  return { treino: updated, novosRecordes };
}

// Aplica um candidato a RP com proteção contra race condition (PR #10).
//
// Modelo: o schema mantém UMA linha por (alunoId, exercicio, metrica, reps) —
// é o "RP ativo". Quando o aluno bate maior, atualizamos in-place; histórico
// fica derivável dos Treinos.
//
// Race protection:
//   1) findUnique pelo @@unique (mais barato e determinístico que findFirst).
//   2) Sem RP → create. P2002 (outro POST concorrente criou) → relê e cai no
//      caminho de update.
//   3) Com RP e kg maior → updateMany com `valor < kg`. O predicado evita
//      regressão se dois POSTs simultâneos tentarem subir o RP: só o maior
//      vence (count=0 nos perdedores, sem novosRecordes duplicado).
//
// Retorna `NovoRecorde` quando houve criação OU melhora; null caso contrário.
async function aplicarRecorde({ alunoId, exercicio, reps, kg, treinoId }) {
  const chave = {
    RecordePessoal_ativo_unq: { alunoId, exercicio, metrica: 'kg_x_reps', reps },
  };

  let rpAtual = await prisma.recordePessoal.findUnique({ where: chave });

  if (!rpAtual) {
    try {
      const novo = await prisma.recordePessoal.create({
        data: {
          alunoId,
          modalidade: 'MUSCULACAO',
          exercicio,
          metrica: 'kg_x_reps',
          valor: kg,
          unidade: 'kg',
          reps,
          treinoId,
        },
      });
      return {
        id: novo.id,
        exercicio: novo.exercicio,
        valor: novo.valor,
        unidade: novo.unidade,
        reps: novo.reps,
        dataRecorde: novo.dataRecorde,
        anterior: null,
      };
    } catch (err) {
      // P2002 = unique violation. Outro POST concorrente criou a linha
      // entre o findUnique e o create — relê e continua como update.
      if (err?.code !== 'P2002') throw err;
      rpAtual = await prisma.recordePessoal.findUnique({ where: chave });
      if (!rpAtual) return null; // estado impossível pós-P2002; desiste silenciosamente
    }
  }

  if (kg <= rpAtual.valor) return null;

  const agora = new Date();
  const result = await prisma.recordePessoal.updateMany({
    where: { id: rpAtual.id, valor: { lt: kg } },
    data: { valor: kg, dataRecorde: agora, treinoId },
  });
  if (result.count === 0) return null; // outro update já subiu pra valor >= kg

  return {
    id: rpAtual.id,
    exercicio: rpAtual.exercicio,
    valor: kg,
    unidade: rpAtual.unidade,
    reps: rpAtual.reps,
    dataRecorde: agora,
    anterior: { valor: rpAtual.valor, dataRecorde: rpAtual.dataRecorde },
  };
}

// Valida o payload da execução contra a modalidade real do treino (PR #11).
//
// Regras de roteamento:
//   - Musculação: input deve usar `exercicios[]` (já validado strict no
//     controller). `realizado` no input é proibido — sinaliza cliente
//     desalinhado. Cada `nome` deve existir no prescrito; nomes novos
//     são rejeitados pra evitar que o aluno "invente" exercício e fure
//     o sistema de RP (que indexa por nome).
//   - Não-musculação: `exercicios[]` no input é proibido. `realizado`
//     passa por um schema .strict() específico da modalidade — campos
//     extras (gpsLatitude, etc) viram 400 em vez de gravar lixo no jsonb.
//
// Retorna uma cópia rasa do input com `realizado` substituído pelo
// objeto sanitizado do parse (sem campos extras). NÃO muta o input.
function validarPorModalidade(detalhesPrescritos, input) {
  const tipo = detalhesPrescritos?.tipo;
  if (!tipo) {
    // Treinos seedados antigos podem não ter `tipo`. Mantém retro-compat
    // permitindo passagem direta — equivalente ao comportamento pré-PR #11.
    return input;
  }

  if (tipo === 'musculacao') {
    if (input.realizado !== undefined) {
      throw new HttpError(400, 'Musculação usa exercicios[], não realizado');
    }
    if (Array.isArray(input.exercicios) && Array.isArray(detalhesPrescritos.exercicios)) {
      const prescritos = new Set(detalhesPrescritos.exercicios.map((e) => e.nome));
      for (const ex of input.exercicios) {
        if (!prescritos.has(ex.nome)) {
          throw new HttpError(400, `Exercício "${ex.nome}" não está prescrito neste treino`);
        }
      }
    }
    return input;
  }

  // Não-musculação
  if (input.exercicios !== undefined) {
    throw new HttpError(400, `Modalidade ${tipo} não aceita exercicios[]`);
  }
  if (input.realizado === undefined) {
    return input;
  }
  const schema = getRealizadoSchemaPorTipo(tipo);
  if (!schema) {
    // Tipo desconhecido. Recusa silenciar — sinal de schema-drift.
    throw new HttpError(400, `Modalidade ${tipo} sem schema de validação`);
  }
  const realizadoSanitizado = schema.parse(input.realizado);
  return { ...input, realizado: realizadoSanitizado };
}

// PR #19 — buckets canônicos de distância em corrida. Tolerância de
// ±200m em torno do alvo (≅ 4% no 5K, ≅ 1% no maratona) — cobre erros
// de GPS e curvas de pista sem aceitar "9.5K" como 10K.
//
// `exercicio` aqui é o discriminador no banco; aparece direto na UI
// agrupado por modalidade=CORRIDA.
const BUCKETS_PACE = Object.freeze([
  { exercicio: '5K',    min: 4.8,  max: 5.2 },
  { exercicio: '10K',   min: 9.8,  max: 10.2 },
  { exercicio: '21.1K', min: 20.9, max: 21.3 },
  { exercicio: '42.2K', min: 42.0, max: 42.4 },
]);

export function detectarDistanciaCanonica(km) {
  if (!Number.isFinite(km) || km <= 0) return null;
  return BUCKETS_PACE.find((b) => km >= b.min && km <= b.max) ?? null;
}

// Análogo de `aplicarRecorde` (PR #10), mas pra endurance:
//   - metrica='pace', unidade='s/km' (segundos por km, decimal)
//   - reps=NULL — unique parcial `RecordePessoal_pace_unq`
//     (migration 20260517190000) garante exclusividade no DB
//   - lower-is-better → updateMany WHERE valor > novoPace (INVERSO
//     do `valor < kg` da musculação)
//
// findFirst em vez de findUnique: o unique nativo do Prisma inclui
// `reps`, e reps=NULL não é considerado "igual" em UNIQUE Postgres
// padrão — o índice nativo NÃO bloqueia duplicação aqui. Quem bloqueia
// é o índice parcial criado via raw SQL. Findunique buscaria pela
// chave do unique nativo (que não cobre nosso caso); findFirst é
// honesto sobre o que queremos.
async function aplicarRecordePace({ alunoId, exercicio, segPorKm, treinoId }) {
  const where = { alunoId, exercicio, metrica: 'pace', reps: null };

  let rpAtual = await prisma.recordePessoal.findFirst({ where });

  if (!rpAtual) {
    try {
      const novo = await prisma.recordePessoal.create({
        data: {
          alunoId,
          modalidade: 'CORRIDA',
          exercicio,
          metrica: 'pace',
          valor: segPorKm,
          unidade: 's/km',
          reps: null,
          treinoId,
        },
      });
      return {
        id: novo.id,
        exercicio: novo.exercicio,
        valor: novo.valor,
        unidade: novo.unidade,
        reps: novo.reps,
        dataRecorde: novo.dataRecorde,
        anterior: null,
      };
    } catch (err) {
      // P2002 do unique parcial: outro POST concorrente criou a linha.
      // Relê e segue pelo caminho de update.
      if (err?.code !== 'P2002') throw err;
      rpAtual = await prisma.recordePessoal.findFirst({ where });
      if (!rpAtual) return null;
    }
  }

  // Lower-is-better: novo só vence se for ESTRITAMENTE MENOR.
  if (segPorKm >= rpAtual.valor) return null;

  const agora = new Date();
  const result = await prisma.recordePessoal.updateMany({
    // INVERSO da musculação: `gt` (valor maior que o novo) — só
    // atualiza se ninguém já tinha batido um pace ainda menor.
    where: { id: rpAtual.id, valor: { gt: segPorKm } },
    data: { valor: segPorKm, dataRecorde: agora, treinoId },
  });
  if (result.count === 0) return null;

  return {
    id: rpAtual.id,
    exercicio: rpAtual.exercicio,
    valor: segPorKm,
    unidade: rpAtual.unidade,
    reps: rpAtual.reps,
    dataRecorde: agora,
    anterior: { valor: rpAtual.valor, dataRecorde: rpAtual.dataRecorde },
  };
}

function mergeRealizado(detalhesAtual, input) {
  if (!detalhesAtual) return detalhesAtual;
  const detalhes = JSON.parse(JSON.stringify(detalhesAtual));

  if (detalhes.tipo === 'musculacao' && Array.isArray(input.exercicios)) {
    const incomingByName = new Map(input.exercicios.map((e) => [e.nome, e.realizado]));
    detalhes.exercicios = detalhes.exercicios.map((ex) => {
      if (incomingByName.has(ex.nome)) {
        return { ...ex, realizado: incomingByName.get(ex.nome) };
      }
      return ex;
    });
  } else if (input.realizado !== undefined && detalhes.tipo !== 'musculacao') {
    detalhes.realizado = input.realizado;
  }
  return detalhes;
}
