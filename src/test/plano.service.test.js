import { describe, it, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// PR #18b — plano alimentar service: ACL + transação de "ativo único".

const state = {
  alunoByUserId: new Map(),
  alunoById: new Map(),
  professorByUserId: new Map(),
  nutricionistaByUserId: new Map(),
  vinculoProfessor: new Map(),
  vinculoNutricionista: new Map(),
  planos: new Map(), // id → row
  txOps: [], // captura ops da $transaction pra inspeção
};

mock.module('../lib/prisma.js', {
  namedExports: {
    prisma: {
      aluno: {
        findUnique: async ({ where }) => {
          if (where.userId) return state.alunoByUserId.get(where.userId) ?? null;
          if (where.id) return state.alunoById.get(where.id) ?? null;
          return null;
        },
      },
      professor: {
        findUnique: async ({ where }) => state.professorByUserId.get(where.userId) ?? null,
      },
      nutricionista: {
        findUnique: async ({ where }) => state.nutricionistaByUserId.get(where.userId) ?? null,
      },
      vinculoProfessor: {
        findUnique: async ({ where }) => {
          const k = where.alunoId_professorId;
          return state.vinculoProfessor.get(`${k.alunoId}|${k.professorId}`) ?? null;
        },
      },
      vinculoNutricionista: {
        findUnique: async ({ where }) => {
          const k = where.alunoId_nutricionistaId;
          return state.vinculoNutricionista.get(`${k.alunoId}|${k.nutricionistaId}`) ?? null;
        },
      },
      planoAlimentar: {
        findUnique: async ({ where }) => state.planos.get(where.id) ?? null,
        findFirst: async ({ where }) => {
          for (const p of state.planos.values()) {
            if (where.alunoId && p.alunoId !== where.alunoId) continue;
            if (where.ativo !== undefined && p.ativo !== where.ativo) continue;
            return p;
          }
          return null;
        },
        findMany: async ({ where }) => {
          const out = [];
          for (const p of state.planos.values()) {
            if (where.alunoId && p.alunoId !== where.alunoId) continue;
            if (where.ativo !== undefined && p.ativo !== where.ativo) continue;
            out.push(p);
          }
          return out;
        },
        updateMany: async ({ where, data }) => {
          let count = 0;
          for (const [id, p] of state.planos) {
            if (where.alunoId && p.alunoId !== where.alunoId) continue;
            if (where.ativo !== undefined && p.ativo !== where.ativo) continue;
            state.planos.set(id, { ...p, ...data });
            count++;
          }
          return { count };
        },
        create: async ({ data }) => {
          const row = { id: `p-${state.planos.size + 1}`, ...data, criadoEm: new Date() };
          state.planos.set(row.id, row);
          return row;
        },
        update: async ({ where, data }) => {
          const cur = state.planos.get(where.id);
          if (!cur) throw new Error('not found');
          const updated = { ...cur, ...data };
          state.planos.set(where.id, updated);
          return updated;
        },
        delete: async ({ where }) => {
          state.planos.delete(where.id);
          return { id: where.id };
        },
      },
      // Executa cada op da array sequencialmente e retorna em ordem.
      // Em produção é atômico via Postgres; aqui simulamos sequencial.
      $transaction: async (ops) => {
        state.txOps.push(ops.length);
        const out = [];
        for (const op of ops) out.push(await op);
        return out;
      },
    },
  },
});

let listPlanos, getPlanoAtual, createPlano, updatePlano, deletePlano;
before(async () => {
  ({ listPlanos, getPlanoAtual, createPlano, updatePlano, deletePlano } =
    await import('../services/plano.service.js'));
});

beforeEach(() => {
  state.alunoByUserId.clear();
  state.alunoById.clear();
  state.professorByUserId.clear();
  state.nutricionistaByUserId.clear();
  state.vinculoProfessor.clear();
  state.vinculoNutricionista.clear();
  state.planos.clear();
  state.txOps = [];

  const aluno1 = { id: 'aluno-1', userId: 'user-aluno-1' };
  state.alunoByUserId.set('user-aluno-1', aluno1);
  state.alunoById.set('aluno-1', aluno1);

  state.nutricionistaByUserId.set('user-nutri-1', { id: 'nutri-1', userId: 'user-nutri-1' });
  state.nutricionistaByUserId.set('user-nutri-2', { id: 'nutri-2', userId: 'user-nutri-2' });

  // Nutri 1 vinculado COM aceite; Nutri 2 vinculado SEM aceite
  state.vinculoNutricionista.set('aluno-1|nutri-1', {
    alunoId: 'aluno-1', nutricionistaId: 'nutri-1', aceitoPeloAluno: true,
  });
  state.vinculoNutricionista.set('aluno-1|nutri-2', {
    alunoId: 'aluno-1', nutricionistaId: 'nutri-2', aceitoPeloAluno: false,
  });

  // Professor 1 vinculado pro caso de leitura/escrita prof
  state.professorByUserId.set('user-prof-1', { id: 'prof-1', userId: 'user-prof-1' });
  state.vinculoProfessor.set('aluno-1|prof-1', { alunoId: 'aluno-1', professorId: 'prof-1' });
});

const userNutri = { userId: 'user-nutri-1', role: 'NUTRICIONISTA' };
const userNutriSemAceite = { userId: 'user-nutri-2', role: 'NUTRICIONISTA' };
const userAluno = { userId: 'user-aluno-1', role: 'ALUNO' };
const userProf = { userId: 'user-prof-1', role: 'PROFESSOR' };

const inputBase = {
  alunoId: 'aluno-1',
  pdfUrl: 'https://apex-test-bucket.s3.sa-east-1.amazonaws.com/plano-alimentar/u1/x.pdf',
  pdfKey: 'plano-alimentar/u1/x.pdf',
  metasText: 'Foco: hipertrofia + corte progressivo',
};

describe('createPlano — ACL', () => {
  it('NUTRI vinculado COM aceite → cria e retorna plano ativo', async () => {
    const plano = await createPlano({ user: userNutri, input: inputBase });
    assert.equal(plano.alunoId, 'aluno-1');
    assert.equal(plano.nutricionistaId, 'nutri-1');
    assert.equal(plano.ativo, true);
    assert.equal(plano.metasText, 'Foco: hipertrofia + corte progressivo');
  });

  it('NUTRI vinculado SEM aceite → 403', async () => {
    await assert.rejects(
      createPlano({ user: userNutriSemAceite, input: inputBase }),
      (err) => err?.status === 403,
    );
  });

  it('ALUNO tenta criar → 403 (apenas nutri escreve)', async () => {
    await assert.rejects(
      createPlano({ user: userAluno, input: inputBase }),
      (err) => err?.status === 403,
    );
  });

  it('PROFESSOR tenta criar → 403 (apenas nutri escreve)', async () => {
    await assert.rejects(
      createPlano({ user: userProf, input: inputBase }),
      (err) => err?.status === 403,
    );
  });
});

describe('createPlano — exclusividade do "ativo"', () => {
  it('criar novo plano DESATIVA os anteriores via $transaction', async () => {
    // Plano antigo já ativo
    await createPlano({ user: userNutri, input: inputBase });

    // Novo plano
    const novo = await createPlano({
      user: userNutri,
      input: { ...inputBase, metasText: 'Plano v2' },
    });

    assert.equal(novo.ativo, true);

    // Lista todos os planos do aluno
    const planos = await listPlanos({
      user: userNutri,
      filters: { alunoId: 'aluno-1', ativo: 'any', limit: 100 },
    });
    const ativos = planos.filter((p) => p.ativo);
    assert.equal(ativos.length, 1, 'só 1 plano ativo após segundo create');
    assert.equal(ativos[0].metasText, 'Plano v2');

    // $transaction foi chamada com [updateMany, create] = 2 ops
    assert.deepEqual(state.txOps, [2, 2]);
  });
});

describe('getPlanoAtual — ACL de leitura', () => {
  it('ALUNO dono → retorna o plano ativo', async () => {
    const novo = await createPlano({ user: userNutri, input: inputBase });
    const atual = await getPlanoAtual({ user: userAluno, alunoId: 'aluno-1' });
    assert.equal(atual?.id, novo.id);
  });

  it('PROFESSOR vinculado → retorna o plano (read permitido)', async () => {
    await createPlano({ user: userNutri, input: inputBase });
    const atual = await getPlanoAtual({ user: userProf, alunoId: 'aluno-1' });
    assert.equal(atual?.alunoId, 'aluno-1');
  });

  it('NUTRI sem aceite → 403 (leitura também exige aceite)', async () => {
    await createPlano({ user: userNutri, input: inputBase });
    await assert.rejects(
      getPlanoAtual({ user: userNutriSemAceite, alunoId: 'aluno-1' }),
      (err) => err?.status === 403,
    );
  });

  it('sem plano cadastrado → retorna null', async () => {
    const atual = await getPlanoAtual({ user: userAluno, alunoId: 'aluno-1' });
    assert.equal(atual, null);
  });
});

describe('updatePlano + deletePlano — só o nutri criador', () => {
  it('outro nutri (vinculado+aceite) NÃO pode editar plano criado por outro', async () => {
    const plano = await createPlano({ user: userNutri, input: inputBase });

    // Tenta editar com nutri-2 — mas nutri-2 está sem aceite no setup.
    // Pra cobrir esse caso, simulamos um terceiro nutri vinculado+aceito.
    state.nutricionistaByUserId.set('user-nutri-3', { id: 'nutri-3', userId: 'user-nutri-3' });
    state.vinculoNutricionista.set('aluno-1|nutri-3', {
      alunoId: 'aluno-1', nutricionistaId: 'nutri-3', aceitoPeloAluno: true,
    });

    await assert.rejects(
      updatePlano({
        user: { userId: 'user-nutri-3', role: 'NUTRICIONISTA' },
        id: plano.id,
        input: { metasText: 'tentativa de takeover' },
      }),
      (err) => err?.status === 403,
    );
  });

  it('nutri criador pode editar metasText', async () => {
    const plano = await createPlano({ user: userNutri, input: inputBase });
    const updated = await updatePlano({
      user: userNutri,
      id: plano.id,
      input: { metasText: 'Foco revisado' },
    });
    assert.equal(updated.metasText, 'Foco revisado');
  });

  it('nutri criador pode deletar plano', async () => {
    const plano = await createPlano({ user: userNutri, input: inputBase });
    const out = await deletePlano({ user: userNutri, id: plano.id });
    assert.equal(out.ok, true);
    assert.equal(state.planos.has(plano.id), false);
  });

  it('plano órfão (nutri saiu, nutricionistaId=null) pode ser editado por qualquer nutri vinculado', async () => {
    const plano = await createPlano({ user: userNutri, input: inputBase });
    // Simula nutri original saindo (SetNull)
    state.planos.set(plano.id, { ...state.planos.get(plano.id), nutricionistaId: null });

    state.nutricionistaByUserId.set('user-nutri-3', { id: 'nutri-3', userId: 'user-nutri-3' });
    state.vinculoNutricionista.set('aluno-1|nutri-3', {
      alunoId: 'aluno-1', nutricionistaId: 'nutri-3', aceitoPeloAluno: true,
    });

    const updated = await updatePlano({
      user: { userId: 'user-nutri-3', role: 'NUTRICIONISTA' },
      id: plano.id,
      input: { metasText: 'reativado por outro nutri' },
    });
    assert.equal(updated.metasText, 'reativado por outro nutri');
  });

  it('plano inexistente → 404', async () => {
    await assert.rejects(
      updatePlano({ user: userNutri, id: 'fantasma', input: {} }),
      (err) => err?.status === 404,
    );
  });
});
