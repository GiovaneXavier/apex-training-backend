import { prisma } from '../lib/prisma.js';
import { resolveAlunoAccess } from '../lib/access.js';
import { HttpError } from '../middleware/errorHandler.js';

// Cópia local de resolveAlunoAccess removida no PR #4.1.
// Tudo agora vai pelo guardião canônico em ../lib/access.js.
// Para treino, NUTRI nunca escreve — `allowNutriWrite` fica no default false.

export async function listTreinosByAluno({ user, alunoId, filters }) {
  const aluno = await resolveAlunoAccess({ user, alunoId });
  const where = { alunoId: aluno.id };
  if (filters.status) where.status = filters.status;
  if (filters.desde || filters.ate) {
    where.dataAlvo = {};
    if (filters.desde) where.dataAlvo.gte = new Date(filters.desde);
    if (filters.ate) where.dataAlvo.lte = new Date(filters.ate);
  }
  return prisma.treino.findMany({
    where,
    orderBy: { dataAlvo: 'asc' },
    take: filters.limit ?? 50,
  });
}

export async function getTreinoById({ user, treinoId }) {
  const treino = await prisma.treino.findUnique({ where: { id: treinoId } });
  if (!treino) throw new HttpError(404, 'Treino não encontrado');
  await resolveAlunoAccess({ user, alunoId: treino.alunoId });
  return treino;
}

export async function prescreverTreino({ user, input }) {
  if (user.role !== 'PROFESSOR') throw new HttpError(403, 'Apenas professores prescrevem');
  const prof = await prisma.professor.findUnique({ where: { userId: user.userId } });
  if (!prof) throw new HttpError(404, 'Perfil de professor não encontrado');

  await resolveAlunoAccess({ user, alunoId: input.alunoId, write: true });

  return prisma.treino.create({
    data: {
      alunoId: input.alunoId,
      professorId: prof.id,
      modalidade: input.modalidade,
      titulo: input.titulo,
      dataAlvo: new Date(input.dataAlvo),
      detalhes: input.detalhes,
      status: 'PENDENTE',
    },
  });
}

export async function deleteTreino({ user, treinoId }) {
  const treino = await prisma.treino.findUnique({ where: { id: treinoId } });
  if (!treino) throw new HttpError(404, 'Treino não encontrado');
  if (user.role !== 'PROFESSOR') throw new HttpError(403, 'Apenas professores podem cancelar');
  await resolveAlunoAccess({ user, alunoId: treino.alunoId, write: true });
  await prisma.treino.delete({ where: { id: treinoId } });
  return { ok: true };
}

// Histórico de carga: retorna o último set realizado de cada exercício
// que o aluno executou, para sugerir kg/reps ao iniciar nova série.
//
// PR #7: contrato passa a exigir NOME CANONICAL (case-sensitive, como
// gravado em Treino.detalhes via snapshot da rotina). Frontend deixou de
// fazer toLowerCase() no input/lookup. Match exato habilita uso eficiente
// do índice GIN (Treino_detalhes_gin_idx) via operador @>.
//
// Antes: 1 findMany pesado carregando até 60 JSONs inteiros + filtro JS.
// Agora:  N queries paralelas (uma por nome), cada uma é index seek no
//         GIN + LIMIT 1 — payload mínimo e tempo de resposta constante.
//
// Retorna mapa { nomeCanonical → { kg, reps, dataAlvo, treinoId } }.
export async function historicoCargas({ user, nomes, alunoId }) {
  const aluno = await resolveAlunoAccess({ user, alunoId });
  if (!Array.isArray(nomes) || nomes.length === 0) return {};

  const unique = Array.from(new Set(nomes.filter((n) => typeof n === 'string' && n.length > 0)));
  if (unique.length === 0) return {};

  // Uma query @> por nome. Paralelo via Promise.all.
  // Alternativa (OR composto via Prisma.sql.join) funcionaria como uma
  // única round-trip, mas perde legibilidade — em N≤10 o paralelo cabe
  // confortavelmente nos workers do Node sem virar gargalo.
  const rows = await Promise.all(
    unique.map((nome) => prisma.$queryRaw`
      SELECT id, "dataAlvo", detalhes
        FROM "Treino"
       WHERE "alunoId" = ${aluno.id}
         AND modalidade = 'MUSCULACAO'::"Modalidade"
         AND status IN ('CONCLUIDO'::"StatusTreino", 'EM_EXECUCAO'::"StatusTreino")
         AND detalhes @> ${JSON.stringify({ exercicios: [{ nome }] })}::jsonb
       ORDER BY "dataAlvo" DESC
       LIMIT 1
    `),
  );

  const out = {};
  for (let i = 0; i < unique.length; i++) {
    const nome = unique[i];
    const row = rows[i]?.[0];
    if (!row) continue;
    const exs = row.detalhes?.exercicios ?? [];
    // O @> garante que existe pelo menos um exercício com esse nome.
    // .find isola o objeto exato (o JSON pode ter outros exercicios também).
    const ex = exs.find((e) => e.nome === nome);
    if (!ex) continue;
    const realizadoArr = Array.isArray(ex.realizado) ? ex.realizado : [];
    const ultimo = [...realizadoArr].reverse().find((s) => s && (s.kg != null || s.reps != null));
    if (!ultimo) continue;
    out[nome] = {
      kg: ultimo.kg ?? null,
      reps: ultimo.reps ?? null,
      dataAlvo: row.dataAlvo,
      treinoId: row.id,
    };
  }
  return out;
}
