import { describe, it, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';

// Env precisa estar setado ANTES de qualquer import que carregue env.js.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@localhost:5432/test';
process.env.VOICE_ENABLED = 'true';
process.env.ANTHROPIC_API_KEY = 'test-key-not-real';

// Estado mutável do prisma mock.
const state = {
  aluno: null,
  treino: null,
};

mock.module('../lib/prisma.js', {
  namedExports: {
    prisma: {
      aluno: {
        findUnique: async ({ where }) =>
          state.aluno && where.userId === state.aluno.userId ? state.aluno : null,
      },
      treino: {
        findUnique: async ({ where }) =>
          state.treino && where.id === state.treino.id ? state.treino : null,
      },
    },
  },
});

let app;
let voiceService;
let csrfToken;
let authToken;
const userId = 'user-aluno-voice-1';

const WEBM_BUFFER = Buffer.concat([
  Buffer.from([0x1A, 0x45, 0xDF, 0xA3]),
  Buffer.alloc(256, 0),
]);

before(async () => {
  ({ app } = await import('../index.js'));
  voiceService = await import('../services/voice.service.js');

  csrfToken = crypto.randomBytes(16).toString('hex');
  authToken = jwt.sign(
    { sub: userId, userId, role: 'ALUNO', csrf: csrfToken },
    process.env.JWT_SECRET,
    { expiresIn: '1h' },
  );
});

beforeEach(() => {
  state.aluno = { id: 'aluno-vbjj-1', userId };
  state.treino = {
    id: '550e8400-e29b-41d4-a716-446655440001',
    alunoId: 'aluno-vbjj-1',
    detalhes: { tipo: 'jiu_jitsu' },
  };
  // Cliente default = sucesso. Cada teste sobrescreve se quiser.
  voiceService.__setClientForTests({
    messages: {
      create: async () => ({
        content: [
          { type: 'tool_use', name: 'submit_bjj_data', input: { matTimeSegundos: 1500, roundsCompletos: 4, readinessRating: 7, confidence: 0.9 } },
        ],
      }),
    },
  });
});

function authedReq() {
  return request(app)
    .post('/api/voice/parse-bjj')
    .set('Authorization', `Bearer ${authToken}`)
    .set('X-CSRF-Token', csrfToken);
}

describe('POST /api/voice/parse-bjj — autenticação e ACL', () => {
  it('401 sem token', async () => {
    const res = await request(app)
      .post('/api/voice/parse-bjj')
      .attach('audio', WEBM_BUFFER, { filename: 'a.webm', contentType: 'audio/webm' })
      .field('treinoId', state.treino.id);
    assert.equal(res.status, 401);
  });

  it('403 sem CSRF token', async () => {
    const res = await request(app)
      .post('/api/voice/parse-bjj')
      .set('Authorization', `Bearer ${authToken}`)
      .attach('audio', WEBM_BUFFER, { filename: 'a.webm', contentType: 'audio/webm' })
      .field('treinoId', state.treino.id);
    assert.equal(res.status, 403);
  });

  it('403 quando role != ALUNO', async () => {
    const profToken = jwt.sign(
      { sub: userId, userId, role: 'PROFESSOR', csrf: csrfToken },
      process.env.JWT_SECRET,
      { expiresIn: '1h' },
    );
    const res = await request(app)
      .post('/api/voice/parse-bjj')
      .set('Authorization', `Bearer ${profToken}`)
      .set('X-CSRF-Token', csrfToken)
      .attach('audio', WEBM_BUFFER, { filename: 'a.webm', contentType: 'audio/webm' })
      .field('treinoId', state.treino.id);
    assert.equal(res.status, 403);
  });

  it('403 quando treino é de outro aluno (anti billing-drain)', async () => {
    state.treino.alunoId = 'outro-aluno';
    const res = await authedReq()
      .attach('audio', WEBM_BUFFER, { filename: 'a.webm', contentType: 'audio/webm' })
      .field('treinoId', state.treino.id);
    assert.equal(res.status, 403);
  });

  it('404 quando treino não existe', async () => {
    state.treino = null;
    const res = await authedReq()
      .attach('audio', WEBM_BUFFER, { filename: 'a.webm', contentType: 'audio/webm' })
      .field('treinoId', '550e8400-e29b-41d4-a716-446655440099');
    assert.equal(res.status, 404);
  });

  it('400 quando modalidade do treino não é jiu_jitsu', async () => {
    state.treino.detalhes = { tipo: 'corrida' };
    const res = await authedReq()
      .attach('audio', WEBM_BUFFER, { filename: 'a.webm', contentType: 'audio/webm' })
      .field('treinoId', state.treino.id);
    assert.equal(res.status, 400);
  });
});

describe('POST /api/voice/parse-bjj — validação de payload', () => {
  it('400 sem campo audio', async () => {
    const res = await authedReq().field('treinoId', state.treino.id);
    assert.equal(res.status, 400);
  });

  it('400 treinoId inválido (não-UUID)', async () => {
    const res = await authedReq()
      .attach('audio', WEBM_BUFFER, { filename: 'a.webm', contentType: 'audio/webm' })
      .field('treinoId', 'not-a-uuid');
    assert.equal(res.status, 400);
  });

  it('415 mime fora da allowlist', async () => {
    const res = await authedReq()
      .attach('audio', WEBM_BUFFER, { filename: 'a.wav', contentType: 'audio/wav' })
      .field('treinoId', state.treino.id);
    assert.equal(res.status, 415);
  });

  it('413 áudio acima de 5MB', async () => {
    const big = Buffer.concat([
      Buffer.from([0x1A, 0x45, 0xDF, 0xA3]),
      Buffer.alloc(6 * 1024 * 1024, 0),
    ]);
    const res = await authedReq()
      .attach('audio', big, { filename: 'a.webm', contentType: 'audio/webm' })
      .field('treinoId', state.treino.id);
    assert.equal(res.status, 413);
  });
});

describe('POST /api/voice/parse-bjj — happy path + service integration', () => {
  it('200 retorna fields, confidence, needsReview, partial, warnings', async () => {
    const res = await authedReq()
      .attach('audio', WEBM_BUFFER, { filename: 'a.webm', contentType: 'audio/webm' })
      .field('treinoId', state.treino.id);
    assert.equal(res.status, 200);
    assert.equal(res.body.fields.matTimeSegundos, 1500);
    assert.equal(res.body.fields.roundsCompletos, 4);
    assert.equal(res.body.fields.readinessRating, 7);
    assert.equal(res.body.confidence, 0.9);
    assert.equal(res.body.needsReview, false);
    assert.equal(res.body.partial, false);
    assert.deepEqual(res.body.warnings, []);
  });

  it('aceita iOS video/mp4 (áudio encapsulado)', async () => {
    const mp4 = Buffer.concat([
      Buffer.from([0, 0, 0, 32]),
      Buffer.from('ftyp'),
      Buffer.alloc(128, 0),
    ]);
    const res = await authedReq()
      .attach('audio', mp4, { filename: 'a.mp4', contentType: 'video/mp4' })
      .field('treinoId', state.treino.id);
    assert.equal(res.status, 200);
  });
});
