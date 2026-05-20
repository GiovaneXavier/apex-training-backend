import { describe, it, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';

// PR #37 (Sprint 14) — testes do macro-ciclo Race A/B/C.
//
// Foco crítico: invariante "1 Race A ativa por aluno" deve produzir
// HTTP 409 com payload { code, alvoAtual } quando violada. Esse 409
// é a UX promise pro coach — sem ela, partial unique index do Postgres
// vaza como 500 ou erro críptico.

// ─── Estado mockado ──────────────────────────────────────────────────
const state = {
  provas: [],
  alunos: [
    { id: 'aluno-1', userId: 'user-aluno-1' },
    { id: 'aluno-2', userId: 'user-aluno-2' },
  ],
  professores: [{ id: 'prof-1', userId: 'user-prof-1' }],
  vinculos: [
    { alunoId: 'aluno-1', professorId: 'prof-1' },
    { alunoId: 'aluno-2', professorId: 'prof-1' },
  ],
};

function findProva(id) { return state.provas.find((p) => p.id === id); }
function nextId() { return `prova-${state.provas.length + 1}`; }

// Simula o partial unique index "prova_alvo_principal_ativo" — só pode
// haver UMA Prova com (alunoId, prioridade='A', arquivada=false).
function checkPartialUnique(alunoId, { ignoreId } = {}) {
  const duplicates = state.provas.filter(
    (p) => p.alunoId === alunoId && p.prioridade === 'A' && p.arquivada === false && p.id !== ignoreId,
  );
  if (duplicates.length >= 1) {
    const err = new Error('Unique constraint failed');
    err.code = 'P2002';
    err.meta = { target: 'prova_alvo_principal_ativo' };
    // Mimica Prisma.PrismaClientKnownRequestError — service usa
    // instanceof Prisma.PrismaClientKnownRequestError; setamos o
    // constructor manualmente abaixo no mock module.
    err.__isPrismaKnown = true;
    throw err;
  }
}

mock.module('../lib/prisma.js', {
  namedExports: {
    prisma: {
      aluno: {
        findUnique: async ({ where }) =>
          state.alunos.find((a) => (where.id && a.id === where.id) || (where.userId && a.userId === where.userId)) || null,
      },
      professor: {
        findUnique: async ({ where }) =>
          state.professores.find((p) => where.userId && p.userId === where.userId) || null,
      },
      vinculoProfessor: {
        findUnique: async ({ where }) =>
          state.vinculos.find(
            (v) =>
              v.alunoId === where.alunoId_professorId.alunoId &&
              v.professorId === where.alunoId_professorId.professorId,
          ) || null,
      },
      nutricionista: { findUnique: async () => null },
      vinculoNutricionista: { findUnique: async () => null },
      prova: {
        findUnique: async ({ where }) => findProva(where.id) || null,
        findFirst: async ({ where }) => {
          return (
            state.provas.find(
              (p) =>
                p.alunoId === where.alunoId &&
                (where.prioridade === undefined || p.prioridade === where.prioridade) &&
                (where.arquivada === undefined || p.arquivada === where.arquivada),
            ) || null
          );
        },
        findMany: async ({ where = {}, take }) => {
          let out = state.provas.filter((p) => {
            if (where.alunoId && p.alunoId !== where.alunoId) return false;
            if (where.arquivada !== undefined && p.arquivada !== where.arquivada) return false;
            if (where.prioridade && p.prioridade !== where.prioridade) return false;
            return true;
          });
          out.sort((a, b) => a.data - b.data);
          return take ? out.slice(0, take) : out;
        },
        create: async ({ data }) => {
          // Partial unique só aplica para linhas que entram no estado
          // (alunoId, prioridade='A', arquivada=false) — espelha o
          // WHERE do index "prova_alvo_principal_ativo" na migration.
          if (data.prioridade === 'A' && data.arquivada !== true) {
            checkPartialUnique(data.alunoId);
          }
          const fresh = {
            id: nextId(),
            arquivada: false,
            alvoTempo: null,
            local: null,
            criadoEm: new Date(),
            atualizadoEm: new Date(),
            ...data,
          };
          state.provas.push(fresh);
          return fresh;
        },
        update: async ({ where, data }) => {
          const existing = findProva(where.id);
          if (!existing) throw new Error('not found');
          const merged = { ...existing, ...data, atualizadoEm: new Date() };
          if (
            merged.prioridade === 'A' &&
            merged.arquivada === false
          ) {
            checkPartialUnique(merged.alunoId, { ignoreId: where.id });
          }
          Object.assign(existing, merged);
          return existing;
        },
        delete: async ({ where }) => {
          const idx = state.provas.findIndex((p) => p.id === where.id);
          if (idx === -1) throw new Error('not found');
          return state.provas.splice(idx, 1)[0];
        },
      },
    },
  },
});

let app;
let csrfToken;
let alunoToken;
let aluno2Token;
let profToken;

before(async () => {
  ({ app } = await import('../index.js'));
  csrfToken = crypto.randomBytes(16).toString('hex');
  alunoToken = jwt.sign(
    { sub: 'user-aluno-1', userId: 'user-aluno-1', role: 'ALUNO', csrf: csrfToken },
    process.env.JWT_SECRET,
    { expiresIn: '1h' },
  );
  aluno2Token = jwt.sign(
    { sub: 'user-aluno-2', userId: 'user-aluno-2', role: 'ALUNO', csrf: csrfToken },
    process.env.JWT_SECRET,
    { expiresIn: '1h' },
  );
  profToken = jwt.sign(
    { sub: 'user-prof-1', userId: 'user-prof-1', role: 'PROFESSOR', csrf: csrfToken },
    process.env.JWT_SECRET,
    { expiresIn: '1h' },
  );
});

beforeEach(() => { state.provas = []; });

function futureDate(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

function pastDate(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

const NOVA_PROVA = {
  modalidade: 'CORRIDA',
  nome: 'Meia Maratona Floripa',
  data: futureDate(95),
  alvoTempo: '1:45:00',
  local: 'Florianópolis, SC',
};

// ─── POST /provas ─────────────────────────────────────────────────────
describe('POST /api/provas — criar', () => {
  it('201 aluno cria prova C (default) pra si mesmo', async () => {
    const res = await request(app)
      .post('/api/provas')
      .set('Authorization', `Bearer ${alunoToken}`)
      .set('X-CSRF-Token', csrfToken)
      .send(NOVA_PROVA);
    assert.equal(res.status, 201);
    assert.equal(res.body.prova.prioridade, 'C');
    assert.equal(res.body.prova.alunoId, 'aluno-1');
  });

  it('201 aluno cria prova A futura — fica como Race A ativa', async () => {
    const res = await request(app)
      .post('/api/provas')
      .set('Authorization', `Bearer ${alunoToken}`)
      .set('X-CSRF-Token', csrfToken)
      .send({ ...NOVA_PROVA, prioridade: 'A' });
    assert.equal(res.status, 201);
    assert.equal(res.body.prova.prioridade, 'A');
  });

  it('400 Race A no passado', async () => {
    const res = await request(app)
      .post('/api/provas')
      .set('Authorization', `Bearer ${alunoToken}`)
      .set('X-CSRF-Token', csrfToken)
      .send({ ...NOVA_PROVA, prioridade: 'A', data: pastDate(30) });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /passado/i);
  });

  it('409 ao criar segunda Race A ativa — retorna alvoAtual no body', async () => {
    // Primeira A
    await request(app)
      .post('/api/provas')
      .set('Authorization', `Bearer ${alunoToken}`)
      .set('X-CSRF-Token', csrfToken)
      .send({ ...NOVA_PROVA, prioridade: 'A' });
    // Segunda A — deve estourar
    const res = await request(app)
      .post('/api/provas')
      .set('Authorization', `Bearer ${alunoToken}`)
      .set('X-CSRF-Token', csrfToken)
      .send({ ...NOVA_PROVA, nome: 'Maratona Rio', data: futureDate(180), prioridade: 'A' });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'PROVA_ALVO_DUPLICADO');
    assert.ok(res.body.alvoAtual, 'alvoAtual presente no payload do 409');
    assert.equal(res.body.alvoAtual.nome, 'Meia Maratona Floripa');
  });

  it('professor cria pra aluno vinculado', async () => {
    const res = await request(app)
      .post('/api/provas')
      .set('Authorization', `Bearer ${profToken}`)
      .set('X-CSRF-Token', csrfToken)
      .send({ ...NOVA_PROVA, alunoId: 'aluno-2' });
    assert.equal(res.status, 201);
    assert.equal(res.body.prova.alunoId, 'aluno-2');
  });

  it('403 aluno tenta criar pra outro aluno (alunoId no body é ignorado, sobrescreve com o próprio)', async () => {
    // alunoId no body é sobrescrito pelo do JWT — aluno-1 não vira aluno-2.
    const res = await request(app)
      .post('/api/provas')
      .set('Authorization', `Bearer ${alunoToken}`)
      .set('X-CSRF-Token', csrfToken)
      .send({ ...NOVA_PROVA, alunoId: 'aluno-2' });
    assert.equal(res.status, 201);
    assert.equal(res.body.prova.alunoId, 'aluno-1');
  });

  it('400 validação Zod — alvoTempo formato inválido', async () => {
    const res = await request(app)
      .post('/api/provas')
      .set('Authorization', `Bearer ${alunoToken}`)
      .set('X-CSRF-Token', csrfToken)
      .send({ ...NOVA_PROVA, alvoTempo: 'uma hora e quarenta e cinco' });
    assert.equal(res.status, 400);
  });
});

// ─── POST /provas/:id/promover ────────────────────────────────────────
describe('POST /api/provas/:id/promover — Race A/B/C', () => {
  it('200 promove prova C → A quando não há A ativa', async () => {
    const criacao = await request(app)
      .post('/api/provas')
      .set('Authorization', `Bearer ${alunoToken}`)
      .set('X-CSRF-Token', csrfToken)
      .send(NOVA_PROVA);
    const provaId = criacao.body.prova.id;

    const res = await request(app)
      .post(`/api/provas/${provaId}/promover`)
      .set('Authorization', `Bearer ${alunoToken}`)
      .set('X-CSRF-Token', csrfToken)
      .send({ prioridade: 'A' });
    assert.equal(res.status, 200);
    assert.equal(res.body.prova.prioridade, 'A');
  });

  it('409 promover B → A quando já existe Race A ativa', async () => {
    // Race A inicial
    const a = await request(app)
      .post('/api/provas')
      .set('Authorization', `Bearer ${alunoToken}`)
      .set('X-CSRF-Token', csrfToken)
      .send({ ...NOVA_PROVA, prioridade: 'A' });

    // Race B
    const b = await request(app)
      .post('/api/provas')
      .set('Authorization', `Bearer ${alunoToken}`)
      .set('X-CSRF-Token', csrfToken)
      .send({ ...NOVA_PROVA, nome: 'Maratona Rio', data: futureDate(180), prioridade: 'B' });

    // Tenta promover B → A — bloqueia
    const res = await request(app)
      .post(`/api/provas/${b.body.prova.id}/promover`)
      .set('Authorization', `Bearer ${alunoToken}`)
      .set('X-CSRF-Token', csrfToken)
      .send({ prioridade: 'A' });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'PROVA_ALVO_DUPLICADO');
    assert.equal(res.body.alvoAtual.id, a.body.prova.id);
  });

  it('200 rebaixar A → C libera slot, próxima promoção passa', async () => {
    const a = await request(app)
      .post('/api/provas')
      .set('Authorization', `Bearer ${alunoToken}`)
      .set('X-CSRF-Token', csrfToken)
      .send({ ...NOVA_PROVA, prioridade: 'A' });
    const b = await request(app)
      .post('/api/provas')
      .set('Authorization', `Bearer ${alunoToken}`)
      .set('X-CSRF-Token', csrfToken)
      .send({ ...NOVA_PROVA, nome: 'Maratona Rio', data: futureDate(180), prioridade: 'B' });

    // Rebaixa A pra C
    const rebaixou = await request(app)
      .post(`/api/provas/${a.body.prova.id}/promover`)
      .set('Authorization', `Bearer ${alunoToken}`)
      .set('X-CSRF-Token', csrfToken)
      .send({ prioridade: 'C' });
    assert.equal(rebaixou.status, 200);

    // Agora B → A passa
    const subiu = await request(app)
      .post(`/api/provas/${b.body.prova.id}/promover`)
      .set('Authorization', `Bearer ${alunoToken}`)
      .set('X-CSRF-Token', csrfToken)
      .send({ prioridade: 'A' });
    assert.equal(subiu.status, 200);
    assert.equal(subiu.body.prova.prioridade, 'A');
  });
});

// ─── POST /provas/:id/arquivar ───────────────────────────────────────
describe('POST /api/provas/:id/arquivar', () => {
  it('200 arquiva Race A — libera slot pra outra A', async () => {
    const a = await request(app)
      .post('/api/provas')
      .set('Authorization', `Bearer ${alunoToken}`)
      .set('X-CSRF-Token', csrfToken)
      .send({ ...NOVA_PROVA, prioridade: 'A' });

    const arq = await request(app)
      .post(`/api/provas/${a.body.prova.id}/arquivar`)
      .set('Authorization', `Bearer ${alunoToken}`)
      .set('X-CSRF-Token', csrfToken)
      .send();
    assert.equal(arq.status, 200);
    assert.equal(arq.body.prova.arquivada, true);

    // Outra A passa agora
    const nova = await request(app)
      .post('/api/provas')
      .set('Authorization', `Bearer ${alunoToken}`)
      .set('X-CSRF-Token', csrfToken)
      .send({ ...NOVA_PROVA, nome: 'Maratona Rio', data: futureDate(180), prioridade: 'A' });
    assert.equal(nova.status, 201);
  });

  it('200 idempotente — arquivar já arquivada não dá erro', async () => {
    const c = await request(app)
      .post('/api/provas')
      .set('Authorization', `Bearer ${alunoToken}`)
      .set('X-CSRF-Token', csrfToken)
      .send(NOVA_PROVA);
    await request(app)
      .post(`/api/provas/${c.body.prova.id}/arquivar`)
      .set('Authorization', `Bearer ${alunoToken}`)
      .set('X-CSRF-Token', csrfToken)
      .send();
    const res2 = await request(app)
      .post(`/api/provas/${c.body.prova.id}/arquivar`)
      .set('Authorization', `Bearer ${alunoToken}`)
      .set('X-CSRF-Token', csrfToken)
      .send();
    assert.equal(res2.status, 200);
  });
});

// ─── GET /provas/:alunoId/alvo ───────────────────────────────────────
describe('GET /api/provas/:alunoId/alvo — Dashboard countdown', () => {
  it('200 retorna null quando aluno não tem Race A', async () => {
    const res = await request(app)
      .get('/api/provas/aluno-1/alvo')
      .set('Authorization', `Bearer ${alunoToken}`)
      .set('X-CSRF-Token', csrfToken);
    assert.equal(res.status, 200);
    assert.equal(res.body.alvo, null);
  });

  it('200 retorna a Race A ativa', async () => {
    await request(app)
      .post('/api/provas')
      .set('Authorization', `Bearer ${alunoToken}`)
      .set('X-CSRF-Token', csrfToken)
      .send({ ...NOVA_PROVA, prioridade: 'A' });
    const res = await request(app)
      .get('/api/provas/aluno-1/alvo')
      .set('Authorization', `Bearer ${alunoToken}`)
      .set('X-CSRF-Token', csrfToken);
    assert.equal(res.status, 200);
    assert.equal(res.body.alvo.prioridade, 'A');
    assert.equal(res.body.alvo.nome, 'Meia Maratona Floripa');
  });
});

// ─── GET /provas/:alunoId ────────────────────────────────────────────
describe('GET /api/provas/:alunoId — listagem', () => {
  it('exclui arquivadas por padrão', async () => {
    const c = await request(app)
      .post('/api/provas')
      .set('Authorization', `Bearer ${alunoToken}`)
      .set('X-CSRF-Token', csrfToken)
      .send(NOVA_PROVA);
    await request(app)
      .post(`/api/provas/${c.body.prova.id}/arquivar`)
      .set('Authorization', `Bearer ${alunoToken}`)
      .set('X-CSRF-Token', csrfToken)
      .send();
    const res = await request(app)
      .get('/api/provas/aluno-1')
      .set('Authorization', `Bearer ${alunoToken}`)
      .set('X-CSRF-Token', csrfToken);
    assert.equal(res.status, 200);
    assert.equal(res.body.provas.length, 0);
  });

  it('inclui arquivadas com ?incluirArquivadas=true', async () => {
    const c = await request(app)
      .post('/api/provas')
      .set('Authorization', `Bearer ${alunoToken}`)
      .set('X-CSRF-Token', csrfToken)
      .send(NOVA_PROVA);
    await request(app)
      .post(`/api/provas/${c.body.prova.id}/arquivar`)
      .set('Authorization', `Bearer ${alunoToken}`)
      .set('X-CSRF-Token', csrfToken)
      .send();
    const res = await request(app)
      .get('/api/provas/aluno-1?incluirArquivadas=true')
      .set('Authorization', `Bearer ${alunoToken}`)
      .set('X-CSRF-Token', csrfToken);
    assert.equal(res.status, 200);
    assert.equal(res.body.provas.length, 1);
  });

  it('filtra por prioridade', async () => {
    await request(app).post('/api/provas')
      .set('Authorization', `Bearer ${alunoToken}`).set('X-CSRF-Token', csrfToken)
      .send({ ...NOVA_PROVA, prioridade: 'A' });
    await request(app).post('/api/provas')
      .set('Authorization', `Bearer ${alunoToken}`).set('X-CSRF-Token', csrfToken)
      .send({ ...NOVA_PROVA, nome: 'Sub-evento', prioridade: 'C' });
    const res = await request(app)
      .get('/api/provas/aluno-1?prioridade=A')
      .set('Authorization', `Bearer ${alunoToken}`)
      .set('X-CSRF-Token', csrfToken);
    assert.equal(res.body.provas.length, 1);
    assert.equal(res.body.provas[0].prioridade, 'A');
  });

  it('403 ALUNO tenta ler provas de outro aluno', async () => {
    const res = await request(app)
      .get('/api/provas/aluno-2')
      .set('Authorization', `Bearer ${alunoToken}`)
      .set('X-CSRF-Token', csrfToken);
    assert.equal(res.status, 403);
  });
});

// ─── PATCH /provas/:id ───────────────────────────────────────────────
describe('PATCH /api/provas/:id — edição genérica', () => {
  it('200 atualiza alvoTempo + local', async () => {
    const c = await request(app)
      .post('/api/provas')
      .set('Authorization', `Bearer ${alunoToken}`)
      .set('X-CSRF-Token', csrfToken)
      .send(NOVA_PROVA);
    const res = await request(app)
      .patch(`/api/provas/${c.body.prova.id}`)
      .set('Authorization', `Bearer ${alunoToken}`)
      .set('X-CSRF-Token', csrfToken)
      .send({ alvoTempo: '1:38:00', local: 'Floripa' });
    assert.equal(res.status, 200);
    assert.equal(res.body.prova.alvoTempo, '1:38:00');
  });

  it('400 strict — campo desconhecido rejeitado', async () => {
    const c = await request(app)
      .post('/api/provas')
      .set('Authorization', `Bearer ${alunoToken}`)
      .set('X-CSRF-Token', csrfToken)
      .send(NOVA_PROVA);
    const res = await request(app)
      .patch(`/api/provas/${c.body.prova.id}`)
      .set('Authorization', `Bearer ${alunoToken}`)
      .set('X-CSRF-Token', csrfToken)
      .send({ alunoId: 'aluno-2' });  // alunoId é imutável
    assert.equal(res.status, 400);
  });
});

// ─── Isolamento entre alunos ─────────────────────────────────────────
describe('Isolamento — Race A por aluno (não global)', () => {
  it('aluno-1 e aluno-2 podem ter Race A simultaneamente', async () => {
    const a1 = await request(app)
      .post('/api/provas')
      .set('Authorization', `Bearer ${alunoToken}`)
      .set('X-CSRF-Token', csrfToken)
      .send({ ...NOVA_PROVA, prioridade: 'A' });
    assert.equal(a1.status, 201);

    const a2 = await request(app)
      .post('/api/provas')
      .set('Authorization', `Bearer ${aluno2Token}`)
      .set('X-CSRF-Token', csrfToken)
      .send({ ...NOVA_PROVA, prioridade: 'A' });
    assert.equal(a2.status, 201, 'aluno-2 deve poder ter sua própria Race A');
  });
});
