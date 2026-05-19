import { describe, it, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// PR #32.5 — testes do ADMIN god-mode.
//
// Cobre as 2 portas que ADMIN bypassa:
//   1. resolveAlunoAccess — carrega QUALQUER aluno sem vínculo.
//   2. requireRole — passa em qualquer requireRole(...).
//
// E confirma o escopo limitado:
//   - ADMIN sem alunoId → 400 (precisa apontar).
//   - ADMIN com alunoId inexistente → 404 (não inventa).
//   - Mutações strict (services com user.role!==X hard-coded) seguem
//     rejeitando ADMIN — escopo declarado: god-mode de LEITURA, não escrita.

const state = {
  aluno: null,
};

mock.module('../lib/prisma.js', {
  namedExports: {
    prisma: {
      aluno: {
        findUnique: async ({ where }) =>
          state.aluno && where.id === state.aluno.id ? state.aluno : null,
      },
    },
  },
});

let access;
let requireRole;

before(async () => {
  ({ resolveAlunoAccess: access } = await import('../lib/access.js'));
  ({ requireRole } = await import('../middleware/auth.middleware.js'));
});

beforeEach(() => {
  state.aluno = { id: 'aluno-real-1', userId: 'user-aluno-1' };
});

describe('resolveAlunoAccess — ADMIN god-mode', () => {
  it('ADMIN com alunoId existente → retorna aluno sem checar vínculo', async () => {
    const out = await access({
      user: { userId: 'user-admin-1', role: 'ADMIN' },
      alunoId: 'aluno-real-1',
    });
    assert.equal(out.id, 'aluno-real-1');
  });

  it('ADMIN SEM alunoId → 400 (deve apontar)', async () => {
    await assert.rejects(
      access({ user: { userId: 'user-admin-1', role: 'ADMIN' } }),
      (e) => e.status === 400,
    );
  });

  it('ADMIN com alunoId inexistente → 404 (não inventa)', async () => {
    state.aluno = null;
    await assert.rejects(
      access({
        user: { userId: 'user-admin-1', role: 'ADMIN' },
        alunoId: 'aluno-fantasma',
      }),
      (e) => e.status === 404,
    );
  });

  it('ADMIN bypassa write=true (pode "escrever" via leitura — service interno é quem decide se executa)', async () => {
    // Bypass de leitura: ADMIN consegue resolver alvo. A escrita real
    // depende de service interno (Treino.professorId precisa de prof),
    // mas o guardião não barra.
    const out = await access({
      user: { userId: 'user-admin-1', role: 'ADMIN' },
      alunoId: 'aluno-real-1',
      write: true,
    });
    assert.equal(out.id, 'aluno-real-1');
  });

  it('Sem ADMIN, paths originais permanecem (ALUNO sem perfil → 404)', async () => {
    state.aluno = null; // aluno do próprio user não existe
    await assert.rejects(
      access({ user: { userId: 'sem-perfil', role: 'ALUNO' } }),
      (e) => e.status === 404,
    );
  });
});

describe('requireRole — ADMIN bypass', () => {
  function callMW(mw, user) {
    return new Promise((resolve) => {
      mw({ user }, {}, (err) => resolve(err));
    });
  }

  it('ADMIN passa em requireRole(PROFESSOR) sem ser professor', async () => {
    const mw = requireRole('PROFESSOR');
    const err = await callMW(mw, { userId: 'u', role: 'ADMIN' });
    assert.equal(err, undefined);
  });

  it('ADMIN passa em requireRole(ALUNO, NUTRICIONISTA) também', async () => {
    const mw = requireRole('ALUNO', 'NUTRICIONISTA');
    const err = await callMW(mw, { userId: 'u', role: 'ADMIN' });
    assert.equal(err, undefined);
  });

  it('Roles normais continuam restritas (ALUNO bloqueado em rota PROFESSOR)', async () => {
    const mw = requireRole('PROFESSOR');
    const err = await callMW(mw, { userId: 'u', role: 'ALUNO' });
    assert.ok(err);
    assert.equal(err.status, 403);
  });

  it('Sem user (não autenticado) → 401 mesmo se "role" fosse ADMIN futuro', async () => {
    const mw = requireRole('PROFESSOR');
    const err = await callMW(mw, null);
    assert.ok(err);
    assert.equal(err.status, 401);
  });
});

describe('ADMIN — escopo de SEGURANÇA (escrita continua strict)', () => {
  // ADMIN bypassa o GUARDIÃO de aluno e o GATE de rota, mas services
  // que fazem `user.role !== 'PROFESSOR'` hard-coded NÃO foram tocados.
  // ADMIN não tem perfil profissional → não consegue mutar mesmo se
  // os checks fossem bypassados.
  //
  // Aqui validamos o invariant: services de criação ainda rejeitam ADMIN.
  // Testes específicos vivem nas suites dos services (treino, plano, etc).
  it('invariant documentado: ADMIN não cria treino (treino.service rejeita)', async () => {
    // Importa direto pra confirmar que a guarda existe.
    const treinoSvc = await import('../services/treino.service.js');
    // prescreverTreino exige user.role==='PROFESSOR' — vai jogar 403.
    await assert.rejects(
      treinoSvc.prescreverTreino({
        user: { userId: 'admin', role: 'ADMIN' },
        input: { alunoId: 'aluno-real-1', modalidade: 'MUSCULACAO',
                 titulo: 'X', dataAlvo: new Date().toISOString(), detalhes: { tipo: 'musculacao' } },
      }),
      (e) => e.status === 403,
    );
  });
});
