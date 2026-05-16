import { describe, it, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// PR #12 — matriz completa do guardião resolveAlunoAccess.
// 3 roles (ALUNO, PROFESSOR, NUTRICIONISTA) × cenários críticos
// (dono, vinculado, sem vínculo, nutri sem aceite, write opt-in, etc).
//
// Estratégia: mockamos o prisma com lookups baseados em maps em memória.
// Cada it() popula o state, chama resolveAlunoAccess e valida status/code.

const state = {
  alunoByUserId: new Map(),
  alunoById: new Map(),
  professorByUserId: new Map(),
  nutricionistaByUserId: new Map(),
  vinculoProfessor: new Map(),    // key: `${alunoId}|${profId}` → row
  vinculoNutricionista: new Map(), // key: `${alunoId}|${nutriId}` → row
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
          const { alunoId, professorId } = where.alunoId_professorId;
          return state.vinculoProfessor.get(`${alunoId}|${professorId}`) ?? null;
        },
      },
      vinculoNutricionista: {
        findUnique: async ({ where }) => {
          const { alunoId, nutricionistaId } = where.alunoId_nutricionistaId;
          return state.vinculoNutricionista.get(`${alunoId}|${nutricionistaId}`) ?? null;
        },
      },
    },
  },
});

let resolveAlunoAccess;
before(async () => {
  ({ resolveAlunoAccess } = await import('../lib/access.js'));
});

beforeEach(() => {
  state.alunoByUserId.clear();
  state.alunoById.clear();
  state.professorByUserId.clear();
  state.nutricionistaByUserId.clear();
  state.vinculoProfessor.clear();
  state.vinculoNutricionista.clear();

  // Sujeitos canônicos pros testes.
  const aluno1 = { id: 'aluno-1', userId: 'user-aluno-1' };
  const aluno2 = { id: 'aluno-2', userId: 'user-aluno-2' };
  state.alunoByUserId.set('user-aluno-1', aluno1);
  state.alunoById.set('aluno-1', aluno1);
  state.alunoByUserId.set('user-aluno-2', aluno2);
  state.alunoById.set('aluno-2', aluno2);

  state.professorByUserId.set('user-prof-1', { id: 'prof-1', userId: 'user-prof-1' });
  state.nutricionistaByUserId.set('user-nutri-1', { id: 'nutri-1', userId: 'user-nutri-1' });
});

async function expectHttp(promise, status) {
  await assert.rejects(promise, (err) => err?.status === status);
}

describe('resolveAlunoAccess — pré-condições', () => {
  it('sem user → 401', async () => {
    await expectHttp(resolveAlunoAccess({ user: null, alunoId: 'aluno-1' }), 401);
  });

  it('user sem role → 401', async () => {
    await expectHttp(
      resolveAlunoAccess({ user: { userId: 'x' }, alunoId: 'aluno-1' }),
      401,
    );
  });

  it('role desconhecida → 403 (fail closed)', async () => {
    await expectHttp(
      resolveAlunoAccess({ user: { userId: 'x', role: 'HACKER' }, alunoId: 'aluno-1' }),
      403,
    );
  });
});

describe('resolveAlunoAccess — ALUNO', () => {
  const userAluno = { userId: 'user-aluno-1', role: 'ALUNO' };

  it('próprio dado (alunoId igual) → retorna aluno', async () => {
    const aluno = await resolveAlunoAccess({ user: userAluno, alunoId: 'aluno-1' });
    assert.equal(aluno.id, 'aluno-1');
  });

  it('alunoId omitido → retorna o próprio aluno (lookup por userId)', async () => {
    const aluno = await resolveAlunoAccess({ user: userAluno });
    assert.equal(aluno.id, 'aluno-1');
  });

  it('alunoId de OUTRO aluno → 403 (não 404, anti-enumeration)', async () => {
    await expectHttp(
      resolveAlunoAccess({ user: userAluno, alunoId: 'aluno-2' }),
      403,
    );
  });

  it('aluno sem perfil cadastrado → 404', async () => {
    await expectHttp(
      resolveAlunoAccess({ user: { userId: 'user-fantasma', role: 'ALUNO' } }),
      404,
    );
  });
});

describe('resolveAlunoAccess — PROFESSOR', () => {
  const userProf = { userId: 'user-prof-1', role: 'PROFESSOR' };

  it('vinculado ao aluno → retorna aluno', async () => {
    state.vinculoProfessor.set('aluno-1|prof-1', { alunoId: 'aluno-1', professorId: 'prof-1' });
    const aluno = await resolveAlunoAccess({ user: userProf, alunoId: 'aluno-1' });
    assert.equal(aluno.id, 'aluno-1');
  });

  it('SEM vínculo com o aluno → 403', async () => {
    // prof existe, vínculo não
    await expectHttp(
      resolveAlunoAccess({ user: userProf, alunoId: 'aluno-1' }),
      403,
    );
  });

  it('professor sem perfil cadastrado → 404', async () => {
    await expectHttp(
      resolveAlunoAccess({ user: { userId: 'user-prof-fantasma', role: 'PROFESSOR' }, alunoId: 'aluno-1' }),
      404,
    );
  });

  it('alunoId omitido → 400 (obrigatório para roles profissionais)', async () => {
    await expectHttp(resolveAlunoAccess({ user: userProf }), 400);
  });

  it('vinculado mas aluno deletado entre lookups → 404', async () => {
    state.vinculoProfessor.set('aluno-1|prof-1', { alunoId: 'aluno-1', professorId: 'prof-1' });
    state.alunoById.delete('aluno-1'); // race / corrupção
    await expectHttp(
      resolveAlunoAccess({ user: userProf, alunoId: 'aluno-1' }),
      404,
    );
  });
});

describe('resolveAlunoAccess — NUTRICIONISTA', () => {
  const userNutri = { userId: 'user-nutri-1', role: 'NUTRICIONISTA' };

  it('vinculado COM aceitoPeloAluno=true (read) → retorna aluno', async () => {
    state.vinculoNutricionista.set('aluno-1|nutri-1', {
      alunoId: 'aluno-1', nutricionistaId: 'nutri-1', aceitoPeloAluno: true,
    });
    const aluno = await resolveAlunoAccess({ user: userNutri, alunoId: 'aluno-1' });
    assert.equal(aluno.id, 'aluno-1');
  });

  it('vinculado SEM aceite → 403 (estrito)', async () => {
    state.vinculoNutricionista.set('aluno-1|nutri-1', {
      alunoId: 'aluno-1', nutricionistaId: 'nutri-1', aceitoPeloAluno: false,
    });
    await expectHttp(
      resolveAlunoAccess({ user: userNutri, alunoId: 'aluno-1' }),
      403,
    );
  });

  it('SEM vínculo → 403', async () => {
    await expectHttp(
      resolveAlunoAccess({ user: userNutri, alunoId: 'aluno-1' }),
      403,
    );
  });

  it('write SEM allowNutriWrite → 403 (secure-by-default)', async () => {
    state.vinculoNutricionista.set('aluno-1|nutri-1', {
      alunoId: 'aluno-1', nutricionistaId: 'nutri-1', aceitoPeloAluno: true,
    });
    await expectHttp(
      resolveAlunoAccess({ user: userNutri, alunoId: 'aluno-1', write: true }),
      403,
    );
  });

  it('write COM allowNutriWrite + aceite → permitido (módulo Evolução ISAK)', async () => {
    state.vinculoNutricionista.set('aluno-1|nutri-1', {
      alunoId: 'aluno-1', nutricionistaId: 'nutri-1', aceitoPeloAluno: true,
    });
    const aluno = await resolveAlunoAccess({
      user: userNutri,
      alunoId: 'aluno-1',
      write: true,
      allowNutriWrite: true,
    });
    assert.equal(aluno.id, 'aluno-1');
  });

  it('write COM allowNutriWrite mas SEM aceite → 403 (aceite ainda manda)', async () => {
    state.vinculoNutricionista.set('aluno-1|nutri-1', {
      alunoId: 'aluno-1', nutricionistaId: 'nutri-1', aceitoPeloAluno: false,
    });
    await expectHttp(
      resolveAlunoAccess({
        user: userNutri,
        alunoId: 'aluno-1',
        write: true,
        allowNutriWrite: true,
      }),
      403,
    );
  });

  it('nutri sem perfil cadastrado → 404', async () => {
    await expectHttp(
      resolveAlunoAccess({
        user: { userId: 'user-nutri-fantasma', role: 'NUTRICIONISTA' },
        alunoId: 'aluno-1',
      }),
      404,
    );
  });

  it('alunoId omitido → 400', async () => {
    await expectHttp(resolveAlunoAccess({ user: userNutri }), 400);
  });
});
