import { prisma } from '../lib/prisma.js';
import { HttpError } from '../middleware/errorHandler.js';
import { getRealizadoSchemaPorTipo } from '../schemas/execucao.schemas.js';

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

  const updated = await prisma.treino.update({
    where: { id: treinoId },
    data: {
      detalhes,
      status: sanitized.status ?? 'CONCLUIDO',
      finalizadoEm: sanitized.finalizadoEm ? new Date(sanitized.finalizadoEm) : new Date(),
    },
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
