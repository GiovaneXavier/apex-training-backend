import { prisma } from '../lib/prisma.js';
import { resolveAlunoAccess } from '../lib/access.js';
import { HttpError } from '../middleware/errorHandler.js';
import { avaliarConquistas } from '../lib/conquistasEngine.js';

// ──────────────────────────────────────────────────────────────
// PR #24 — Jornada do Faixa Preta (BJJ).
//
// CRUD de promoções + agregação da jornada (faixa atual + matTime
// acumulado NA FAIXA ATUAL + meta da próxima faixa + progressoPct).
//
// Regra de negócio crítica:
//   O matTime CONTA SOMENTE a partir da última promoção. Senão um
//   faixa azul recém-promovido já teria horas da faixa branca contando
//   pra meta da roxa. O contador zera a cada promoção (delta, não
//   acumulado vitalício).
//
// Acesso:
//   - READ : ACL canônica (aluno dono / prof vinculado / nutri c/ aceite).
//   - WRITE: ALUNO (auto-registro de promoção própria) ou PROFESSOR
//            (registrar promoção do aluno vinculado).
// ──────────────────────────────────────────────────────────────

// Metas mínimas IBJJF — referência da comunidade (horas de tatame
// estimadas até a próxima faixa). Frente espelha esses números em
// segundos (60×60×N) pra cálculo direto do progressoPct.
const META_HORAS_POR_FAIXA = {
  BRANCA:  { proxima: 'AZUL',   horas: 200 },
  AZUL:    { proxima: 'ROXA',   horas: 400 },
  ROXA:    { proxima: 'MARROM', horas: 600 },
  MARROM:  { proxima: 'PRETA',  horas: 800 },
  PRETA:   null, // endgame — preta tem 6 graus internos
  CORAL:   null,
  VERMELHA: null,
};

export async function getFaixaAtual({ user, alunoId }) {
  const aluno = await resolveAlunoAccess({ user, alunoId });
  return prisma.evolucaoMarcial.findFirst({
    where: { alunoId: aluno.id },
    orderBy: { dataPromocao: 'desc' },
  });
}

export async function listPromocoes({ user, filters }) {
  const aluno = await resolveAlunoAccess({ user, alunoId: filters.alunoId });
  return prisma.evolucaoMarcial.findMany({
    where: { alunoId: aluno.id },
    orderBy: { dataPromocao: 'desc' },
    take: filters.limit ?? 20,
  });
}

export async function registrarPromocao({ user, input }) {
  // ALUNO registra a própria promoção; PROFESSOR registra do aluno
  // vinculado. NUTRI fica de fora (não é seu domínio).
  if (user.role === 'NUTRICIONISTA') {
    throw new HttpError(403, 'Nutricionista não registra promoção marcial');
  }
  const targetAlunoId =
    user.role === 'ALUNO' ? undefined : input.alunoId; // service infere pelo guardião
  const aluno = await resolveAlunoAccess({
    user, alunoId: targetAlunoId, write: true,
  });

  const novo = await prisma.evolucaoMarcial.create({
    data: {
      alunoId: aluno.id,
      faixa: input.faixa,
      grauNum: input.grauNum ?? 0,
      dataPromocao: new Date(input.dataPromocao),
      instrutorNome: input.instrutorNome ?? null,
      observacao: input.observacao ?? null,
    },
  });

  // PR #31 — Conquista de promoção (Sprint 11). Fire-and-forget; falha
  // não derruba a criação da promoção.
  queueMicrotask(() => {
    void avaliarConquistas({
      alunoId: aluno.id,
      trigger: 'FAIXA_PROMOCAO',
      contexto: { faixa: novo.faixa, promocaoId: novo.id },
    });
  });

  return novo;
}

export async function deletePromocao({ user, id }) {
  const row = await prisma.evolucaoMarcial.findUnique({ where: { id } });
  if (!row) throw new HttpError(404, 'Promoção não encontrada');
  // Reuse do guardião: ALUNO só apaga a própria; PROFESSOR vinculado
  // pode corrigir histórico do aluno (caso comum: digitação errada).
  await resolveAlunoAccess({ user, alunoId: row.alunoId, write: true });
  await prisma.evolucaoMarcial.delete({ where: { id } });
  return { ok: true };
}

// ──────────────────────────────────────────────────────────────
// Jornada — peça central da gamificação.
//
// Retorna:
//   - faixaAtual: { faixa, grauNum, dataPromocao, instrutorNome, ... }
//                 ou null (atleta sem promoção registrada)
//   - matTimeNaFaixaSeg: soma de Treino.detalhes.realizado.matTimeSegundos
//                       JIU_JITSU CONCLUIDO com finalizadoEm > dataPromocao
//   - proximaFaixa: nome da próxima ou null (endgame)
//   - metaSegundos: meta IBJJF da próxima faixa em SEGUNDOS, ou null
//   - progressoPct: 0..100 (clampado, mesmo se ultrapassou meta)
// ──────────────────────────────────────────────────────────────
export async function getJornadaMarcial({ user, alunoId }) {
  const aluno = await resolveAlunoAccess({ user, alunoId });
  const id = aluno.id;

  const faixaAtual = await prisma.evolucaoMarcial.findFirst({
    where: { alunoId: id },
    orderBy: { dataPromocao: 'desc' },
  });

  // Sem promoção registrada → atleta acabou de chegar. Retornamos
  // null pro UI mostrar CTA "Registre sua faixa atual" (zero CTA's
  // moralistas tipo "comece como branca" — atleta pode ter chegado
  // como roxa de outra academia).
  if (!faixaAtual) {
    return {
      faixaAtual: null,
      matTimeNaFaixaSeg: 0,
      proximaFaixa: null,
      metaSegundos: null,
      progressoPct: 0,
    };
  }

  // Regra de negócio crítica: matTime só conta DEPOIS da última
  // promoção. `finalizadoEm > dataPromocao` zera o contador na
  // graduação. COALESCE garante 0 quando atleta ainda não treinou
  // depois da promoção (caso comum logo após receber faixa).
  //
  // `jsonb_extract_path_text(...) ~ regex` protege contra valores
  // não-numéricos (treino skipado, atleta esqueceu de preencher).
  // Cast `::integer` é seguro porque o schema Zod já limita a 14_400.
  const rows = await prisma.$queryRaw`
    SELECT COALESCE(SUM(
      (t.detalhes->'realizado'->>'matTimeSegundos')::integer
    ), 0)::integer AS mat_time_seg
    FROM "Treino" t
    WHERE t."alunoId" = ${id}
      AND t.modalidade = 'JIU_JITSU'::"Modalidade"
      AND t.status = 'CONCLUIDO'::"StatusTreino"
      AND t."finalizadoEm" > ${faixaAtual.dataPromocao}
      AND (t.detalhes->'realizado'->>'matTimeSegundos') ~ '^[0-9]+$'
  `;
  const matTimeNaFaixaSeg = Number(rows[0]?.mat_time_seg ?? 0);

  const meta = META_HORAS_POR_FAIXA[faixaAtual.faixa];
  const metaSegundos = meta ? meta.horas * 3600 : null;
  const progressoPct = metaSegundos
    ? Math.min(100, Math.round((matTimeNaFaixaSeg / metaSegundos) * 100))
    : 0;

  return {
    faixaAtual,
    matTimeNaFaixaSeg,
    proximaFaixa: meta?.proxima ?? null,
    metaSegundos,
    progressoPct,
  };
}
