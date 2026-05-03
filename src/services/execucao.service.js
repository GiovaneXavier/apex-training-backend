import { prisma } from '../lib/prisma.js';
import { HttpError } from '../middleware/errorHandler.js';

// Salva execução do aluno + detecta novos RPs (musculação por (exercicio, reps)).
// Retorna { treino, novosRecordes }.
export async function salvarExecucao({ user, treinoId, input }) {
  if (user.role !== 'ALUNO') throw new HttpError(403, 'Apenas alunos podem registrar execução');

  const aluno = await prisma.aluno.findUnique({ where: { userId: user.userId } });
  if (!aluno) throw new HttpError(404, 'Perfil de aluno não encontrado');

  const treino = await prisma.treino.findUnique({ where: { id: treinoId } });
  if (!treino) throw new HttpError(404, 'Treino não encontrado');
  if (treino.alunoId !== aluno.id) throw new HttpError(403, 'Treino de outro aluno');

  // Merge realizado nos detalhes JSON
  const detalhes = mergeRealizado(treino.detalhes, input);

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
      const rpAtual = await prisma.recordePessoal.findFirst({
        where: {
          alunoId: aluno.id,
          exercicio: g.exercicio,
          metrica: 'kg_x_reps',
          reps: g.reps,
        },
        orderBy: { valor: 'desc' },
      });

      if (!rpAtual || g.kg > rpAtual.valor) {
        const novo = await prisma.recordePessoal.create({
          data: {
            alunoId: aluno.id,
            modalidade: 'MUSCULACAO',
            exercicio: g.exercicio,
            metrica: 'kg_x_reps',
            valor: g.kg,
            unidade: 'kg',
            reps: g.reps,
            treinoId,
          },
        });
        novosRecordes.push({
          id: novo.id,
          exercicio: novo.exercicio,
          valor: novo.valor,
          unidade: novo.unidade,
          reps: novo.reps,
          dataRecorde: novo.dataRecorde,
          anterior: rpAtual
            ? { valor: rpAtual.valor, dataRecorde: rpAtual.dataRecorde }
            : null,
        });
      }
    }
  }

  const updated = await prisma.treino.update({
    where: { id: treinoId },
    data: {
      detalhes,
      status: input.status ?? 'CONCLUIDO',
      finalizadoEm: input.finalizadoEm ? new Date(input.finalizadoEm) : new Date(),
    },
  });

  return { treino: updated, novosRecordes };
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
  } else if (input.realizado && (detalhes.tipo === 'corrida' || detalhes.tipo === 'ciclismo' || detalhes.tipo === 'natacao' || detalhes.tipo === 'outro')) {
    detalhes.realizado = input.realizado;
  }
  return detalhes;
}
