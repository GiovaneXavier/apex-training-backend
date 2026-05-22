import { describe, it, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// PR #41c — ACK em batch de auto-matches Tier 1.
//
// Cobre:
//  - ALUNO ack vários treinos próprios → marca ack=true, retorna count
//  - tenta ack treino de OUTRO aluno → updateMany filtra por alunoId, 0
//  - tenta ack treino sem stravaActivityId → filtro elimina, 0
//  - idempotência: re-ack já-true → 0
//  - PROFESSOR/NUTRI → 403 (apenas ALUNO confirma)
//  - lista vazia → 0 (sem query no banco)

const state = {
  alunos: [], // { id, userId }
  treinos: [], // { id, alunoId, stravaActivityId, stravaAutoMatchAck }
  lastUpdateManyWhere: null,
  updateManyCalls: 0,
};

function resetState() {
  state.alunos = [];
  state.treinos = [];
  state.lastUpdateManyWhere = null;
  state.updateManyCalls = 0;
}

mock.module('../lib/prisma.js', {
  namedExports: {
    prisma: {
      aluno: {
        findUnique: async ({ where }) => {
          if (where.userId) return state.alunos.find((a) => a.userId === where.userId) ?? null;
          return null;
        },
      },
      treino: {
        updateMany: async ({ where, data }) => {
          state.updateManyCalls += 1;
          state.lastUpdateManyWhere = where;
          // Replica filtros do service: id in ids, alunoId, stravaActivityId not null, ack=false
          const alvos = state.treinos.filter((t) => {
            if (!where.id.in.includes(t.id)) return false;
            if (t.alunoId !== where.alunoId) return false;
            if (t.stravaActivityId == null) return false;
            if (t.stravaAutoMatchAck !== false) return false;
            return true;
          });
          alvos.forEach((t) => Object.assign(t, data));
          return { count: alvos.length };
        },
      },
    },
  },
});

let ackStravaAutoMatch;
before(async () => {
  ({ ackStravaAutoMatch } = await import('../services/treino.service.js'));
});

beforeEach(() => {
  resetState();
  state.alunos.push({ id: 'aluno_1', userId: 'user_aluno_1' });
  state.alunos.push({ id: 'aluno_2', userId: 'user_aluno_2' });
});

const userAluno1 = { userId: 'user_aluno_1', role: 'ALUNO' };

describe('ackStravaAutoMatch — PR #41c', () => {
  it('ALUNO ack 2 treinos próprios → ambos viram ack=true', async () => {
    state.treinos.push({
      id: 't1', alunoId: 'aluno_1', stravaActivityId: '99', stravaAutoMatchAck: false,
    });
    state.treinos.push({
      id: 't2', alunoId: 'aluno_1', stravaActivityId: '100', stravaAutoMatchAck: false,
    });
    const out = await ackStravaAutoMatch({ user: userAluno1, ids: ['t1', 't2'] });
    assert.equal(out.acked, 2);
    assert.equal(state.treinos[0].stravaAutoMatchAck, true);
    assert.equal(state.treinos[1].stravaAutoMatchAck, true);
  });

  it('ALUNO tenta ack treino de OUTRO aluno → updateMany filtra, 0 atingidos', async () => {
    // Treino existe mas pertence a aluno_2.
    state.treinos.push({
      id: 't_alheio', alunoId: 'aluno_2', stravaActivityId: '77', stravaAutoMatchAck: false,
    });
    const out = await ackStravaAutoMatch({ user: userAluno1, ids: ['t_alheio'] });
    assert.equal(out.acked, 0);
    // Ack do outro aluno permanece false (não foi tocado).
    assert.equal(state.treinos[0].stravaAutoMatchAck, false);
  });

  it('Treino sem stravaActivityId → não é ack (filtro NOT NULL)', async () => {
    state.treinos.push({
      id: 't_sem_strava', alunoId: 'aluno_1', stravaActivityId: null, stravaAutoMatchAck: false,
    });
    const out = await ackStravaAutoMatch({ user: userAluno1, ids: ['t_sem_strava'] });
    assert.equal(out.acked, 0);
  });

  it('Idempotência: re-ack treino já em true → 0', async () => {
    state.treinos.push({
      id: 't_ja_ack', alunoId: 'aluno_1', stravaActivityId: '55', stravaAutoMatchAck: true,
    });
    const out = await ackStravaAutoMatch({ user: userAluno1, ids: ['t_ja_ack'] });
    assert.equal(out.acked, 0);
  });

  it('PROFESSOR → 403', async () => {
    await assert.rejects(
      ackStravaAutoMatch({
        user: { userId: 'user_prof_1', role: 'PROFESSOR' },
        ids: ['t1'],
      }),
      (err) => err.status === 403,
    );
  });

  it('NUTRICIONISTA → 403', async () => {
    await assert.rejects(
      ackStravaAutoMatch({
        user: { userId: 'user_nutri_1', role: 'NUTRICIONISTA' },
        ids: ['t1'],
      }),
      (err) => err.status === 403,
    );
  });

  it('ALUNO sem perfil → 404', async () => {
    await assert.rejects(
      ackStravaAutoMatch({
        user: { userId: 'user_orfao', role: 'ALUNO' },
        ids: ['t1'],
      }),
      (err) => err.status === 404,
    );
  });

  it('Lista vazia → 0 sem tocar banco', async () => {
    const out = await ackStravaAutoMatch({ user: userAluno1, ids: [] });
    assert.equal(out.acked, 0);
    assert.equal(state.updateManyCalls, 0);
  });

  it('Batch misto (próprios + alheios + sem-strava) → ack só os próprios elegíveis', async () => {
    state.treinos.push({
      id: 'a', alunoId: 'aluno_1', stravaActivityId: '1', stravaAutoMatchAck: false,
    });
    state.treinos.push({
      id: 'b', alunoId: 'aluno_2', stravaActivityId: '2', stravaAutoMatchAck: false,
    });
    state.treinos.push({
      id: 'c', alunoId: 'aluno_1', stravaActivityId: null, stravaAutoMatchAck: false,
    });
    state.treinos.push({
      id: 'd', alunoId: 'aluno_1', stravaActivityId: '4', stravaAutoMatchAck: false,
    });
    const out = await ackStravaAutoMatch({
      user: userAluno1,
      ids: ['a', 'b', 'c', 'd', 'inexistente'],
    });
    assert.equal(out.acked, 2); // só a + d
    assert.equal(state.treinos.find((t) => t.id === 'a').stravaAutoMatchAck, true);
    assert.equal(state.treinos.find((t) => t.id === 'd').stravaAutoMatchAck, true);
    assert.equal(state.treinos.find((t) => t.id === 'b').stravaAutoMatchAck, false);
    assert.equal(state.treinos.find((t) => t.id === 'c').stravaAutoMatchAck, false);
  });
});
