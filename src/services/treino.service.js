import { prisma } from '../lib/prisma.js';
import { resolveAlunoAccess } from '../lib/access.js';
import { HttpError } from '../middleware/errorHandler.js';
import { firePush, payloadNovoTreinoPrescrito } from '../lib/pushTriggers.js';

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

// PR #16 — clonar treino prescrito (reaproveitamento de carga).
//
// O caso de uso: prof já prescreveu o treino de natação de quarta e
// quer aplicar o mesmo template na semana seguinte sem redigitar 8
// blocos de séries. Pega o `detalhes` original, zera o `realizado` (se
// houver) e grava como PENDENTE numa nova `dataAlvo`.
//
// Sanitização: o `realizado` pode existir em detalhes de treinos já
// executados ou em progresso. Limpamos pra que o clone nasça virgem.
//   - musculacao: cada exercicios[i].realizado vira []
//   - corrida/ciclismo/natacao/hyrox/outro: realizado vira null
// O `tipo` e a prescrição em si seguem inalterados.
//
// Auth: usa o mesmo guard de `prescreverTreino` (PROFESSOR + vínculo).
// Idempotência: não tem — chamar 2x cria 2 treinos. Frontend desabilita
// o botão durante o POST. Janela de race muito curta na prática.
export async function clonarTreino({ user, treinoId, dataAlvo }) {
  if (user.role !== 'PROFESSOR') throw new HttpError(403, 'Apenas professores podem clonar treinos');

  const origem = await prisma.treino.findUnique({ where: { id: treinoId } });
  if (!origem) throw new HttpError(404, 'Treino de origem não encontrado');

  const prof = await prisma.professor.findUnique({ where: { userId: user.userId } });
  if (!prof) throw new HttpError(404, 'Perfil de professor não encontrado');

  await resolveAlunoAccess({ user, alunoId: origem.alunoId, write: true });

  const detalhesLimpos = limparExecucao(origem.detalhes);

  const novo = await prisma.treino.create({
    data: {
      alunoId: origem.alunoId,
      professorId: prof.id,
      rotinaId: origem.rotinaId, // mantém o link à rotina-mãe se houver
      modalidade: origem.modalidade,
      titulo: origem.titulo,
      dataAlvo: new Date(dataAlvo),
      detalhes: detalhesLimpos,
      status: 'PENDENTE',
    },
  });

  // PR #27 — Gatilho da Prescrição. PROFESSOR clona, ALUNO recebe.
  // Lookup mínimo: só `userId` do aluno alvo. select reduzido pra não
  // hidratar registro inteiro só pra ler 1 campo.
  const alvo = await prisma.aluno.findUnique({
    where: { id: origem.alunoId },
    select: { userId: true },
  });
  firePush({
    userId: alvo?.userId,
    payload: payloadNovoTreinoPrescrito(),
    trigger: 'novo-treino-prescrito',
  });

  return novo;
}

function limparExecucao(detalhes) {
  if (!detalhes || typeof detalhes !== 'object') return detalhes;
  const clone = JSON.parse(JSON.stringify(detalhes));

  if (clone.tipo === 'musculacao' && Array.isArray(clone.exercicios)) {
    clone.exercicios = clone.exercicios.map((ex) => ({ ...ex, realizado: [] }));
  } else if ('realizado' in clone) {
    clone.realizado = null;
  }
  return clone;
}

export async function deleteTreino({ user, treinoId }) {
  const treino = await prisma.treino.findUnique({ where: { id: treinoId } });
  if (!treino) throw new HttpError(404, 'Treino não encontrado');
  if (user.role !== 'PROFESSOR') throw new HttpError(403, 'Apenas professores podem cancelar');
  await resolveAlunoAccess({ user, alunoId: treino.alunoId, write: true });
  await prisma.treino.delete({ where: { id: treinoId } });
  return { ok: true };
}

// PR #41c — ACK em batch dos auto-matches Tier 1 já vistos pelo aluno.
//
// Fluxo: webhook Strava roda matchAtividade → vincularTier1 grava
// stravaAutoMatchAck=false. Dashboard do aluno carrega treinos da semana,
// filtra `stravaActivityId && !stravaAutoMatchAck`, exibe toast
// "X autopreenchidos — Desfazer". Após o render, frontend dispara este
// endpoint com os ids para zerar a flag — evita toast repetido no próximo
// reload e cross-device.
//
// Guards:
//   - Apenas ALUNO (não faz sentido prof/nutri/admin "verem" toast).
//   - updateMany filtra alunoId no WHERE → impossível ACK em treino alheio
//     mesmo se enviado id de outro aluno (silenciosamente ignorado).
//   - stravaActivityId NOT NULL no WHERE → não toca registros sem vínculo.
//   - Idempotente: re-bater o mesmo id é no-op (já está em true).
export async function ackStravaAutoMatch({ user, ids }) {
  if (user.role !== 'ALUNO') throw new HttpError(403, 'Apenas alunos confirmam auto-match');
  const aluno = await prisma.aluno.findUnique({
    where: { userId: user.userId },
    select: { id: true },
  });
  if (!aluno) throw new HttpError(404, 'Perfil de aluno não encontrado');

  if (!Array.isArray(ids) || ids.length === 0) return { acked: 0 };

  const result = await prisma.treino.updateMany({
    where: {
      id: { in: ids },
      alunoId: aluno.id,
      stravaActivityId: { not: null },
      stravaAutoMatchAck: false,
    },
    data: { stravaAutoMatchAck: true },
  });
  return { acked: result.count };
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
