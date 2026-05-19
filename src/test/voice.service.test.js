import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// Habilita feature flag ANTES do import do env. Os outros testes não importam
// env.js diretamente, então não precisam dessas vars — voice.service sim.
// env.js roda loadEnv() na import; precisa de DATABASE_URL pra passar.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@localhost:5432/test';
process.env.VOICE_ENABLED = 'true';
process.env.ANTHROPIC_API_KEY = 'test-key-not-real';

const serviceModule = await import('../services/voice.service.js');
const {
  transcribeAndExtract,
  detectAudioContainer,
  __setClientForTests,
  __resetClientForTests,
} = serviceModule;

// PR #25 — service de Diário de Voz.
//
// Mockamos o cliente Anthropic inteiro pra exercitar:
//   - happy path tool_use → JSON válido → fields canônicos
//   - tool_use com campo inválido (readiness=15) → partial: true + warning
//   - tool_use ausente → 502
//   - rede caindo (throw) → 504
//   - rate limit upstream (429) → 429
//   - áudio com magic byte desconhecido → 415 sem chamar LLM
//   - confidence baixo → needsReview: true

function makeClientThatReturns(toolInput) {
  return {
    messages: {
      create: async () => ({
        content: [
          { type: 'tool_use', name: 'submit_bjj_data', input: toolInput },
        ],
      }),
    },
  };
}

function makeClientThatThrows(error) {
  return {
    messages: {
      create: async () => { throw error; },
    },
  };
}

// Buffers mínimos com magic bytes válidos.
const WEBM_BUFFER = Buffer.concat([
  Buffer.from([0x1A, 0x45, 0xDF, 0xA3]),
  Buffer.alloc(64, 0),
]);

const GARBAGE_BUFFER = Buffer.from('hello world this is not audio');

describe('detectAudioContainer — magic bytes', () => {
  it('reconhece webm', () => {
    assert.equal(detectAudioContainer(WEBM_BUFFER), 'webm');
  });

  it('reconhece ogg', () => {
    const ogg = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(20, 0)]);
    assert.equal(detectAudioContainer(ogg), 'ogg');
  });

  it('reconhece mp4 (ftyp em offset 4)', () => {
    const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 32]), Buffer.from('ftyp'), Buffer.alloc(50, 0)]);
    assert.equal(detectAudioContainer(mp4), 'mp4');
  });

  it('rejeita buffer não-audio', () => {
    assert.equal(detectAudioContainer(GARBAGE_BUFFER), null);
  });

  it('rejeita buffer vazio / não-buffer', () => {
    assert.equal(detectAudioContainer(Buffer.alloc(0)), null);
    assert.equal(detectAudioContainer(null), null);
    assert.equal(detectAudioContainer('not a buffer'), null);
  });
});

describe('transcribeAndExtract — happy path', () => {
  beforeEach(() => __resetClientForTests());
  afterEach(() => __resetClientForTests());

  it('extrai fields válidos do tool_use', async () => {
    __setClientForTests(makeClientThatReturns({
      matTimeSegundos: 1500,
      roundsCompletos: 4,
      finalizacoesFeitas: 3,
      finalizacoesSofridas: 1,
      readinessRating: 7,
      observacao: 'Foi puxado.',
      confidence: 0.92,
    }));

    const out = await transcribeAndExtract({
      audioBuffer: WEBM_BUFFER,
      mimeType: 'audio/webm',
      modalidade: 'jiu_jitsu',
    });

    assert.equal(out.fields.matTimeSegundos, 1500);
    assert.equal(out.fields.roundsCompletos, 4);
    assert.equal(out.fields.readinessRating, 7);
    assert.equal(out.confidence, 0.92);
    assert.equal(out.needsReview, false);
    assert.equal(out.partial, false);
    assert.deepEqual(out.warnings, []);
    // Confidence NÃO deve aparecer nos fields canônicos (não é parte do schema BJJ).
    assert.equal(out.fields.confidence, undefined);
  });

  it('payload mínimo (só matTime) sobrevive', async () => {
    __setClientForTests(makeClientThatReturns({
      matTimeSegundos: 3600,
      confidence: 0.85,
    }));

    const out = await transcribeAndExtract({
      audioBuffer: WEBM_BUFFER,
      mimeType: 'audio/webm',
      modalidade: 'jiu_jitsu',
    });

    assert.equal(out.fields.matTimeSegundos, 3600);
    assert.equal(out.partial, false);
  });
});

describe('transcribeAndExtract — degradação graciosa', () => {
  beforeEach(() => __resetClientForTests());
  afterEach(() => __resetClientForTests());

  it('readinessRating=15 → partial: true + warning, demais campos preservados', async () => {
    __setClientForTests(makeClientThatReturns({
      matTimeSegundos: 1500,
      readinessRating: 15, // fora de 1..10
      confidence: 0.8,
    }));

    const out = await transcribeAndExtract({
      audioBuffer: WEBM_BUFFER,
      mimeType: 'audio/webm',
      modalidade: 'jiu_jitsu',
    });

    assert.equal(out.partial, true);
    assert.equal(out.needsReview, true);
    assert.equal(out.fields.matTimeSegundos, 1500);
    assert.equal(out.fields.readinessRating, undefined);
    assert.ok(out.warnings.some((w) => w.includes('readinessRating')), 'warning deve citar readinessRating');
  });

  it('confidence < 0.6 → needsReview: true mesmo sem partial', async () => {
    __setClientForTests(makeClientThatReturns({
      matTimeSegundos: 1500,
      confidence: 0.3,
    }));

    const out = await transcribeAndExtract({
      audioBuffer: WEBM_BUFFER,
      mimeType: 'audio/webm',
      modalidade: 'jiu_jitsu',
    });

    assert.equal(out.needsReview, true);
    assert.equal(out.partial, false);
  });

  it('tool_use ausente → 502', async () => {
    __setClientForTests({
      messages: {
        create: async () => ({ content: [{ type: 'text', text: 'sorry' }] }),
      },
    });

    await assert.rejects(
      transcribeAndExtract({
        audioBuffer: WEBM_BUFFER,
        mimeType: 'audio/webm',
        modalidade: 'jiu_jitsu',
      }),
      (err) => err.status === 502,
    );
  });

  it('rede caindo → 504', async () => {
    __setClientForTests(makeClientThatThrows(new Error('ETIMEDOUT')));

    await assert.rejects(
      transcribeAndExtract({
        audioBuffer: WEBM_BUFFER,
        mimeType: 'audio/webm',
        modalidade: 'jiu_jitsu',
      }),
      (err) => err.status === 504,
    );
  });

  it('upstream 429 → 429 (propaga para rate-limit UX)', async () => {
    const err = new Error('rate limited');
    err.status = 429;
    __setClientForTests(makeClientThatThrows(err));

    await assert.rejects(
      transcribeAndExtract({
        audioBuffer: WEBM_BUFFER,
        mimeType: 'audio/webm',
        modalidade: 'jiu_jitsu',
      }),
      (e) => e.status === 429,
    );
  });

  it('upstream 401 (key inválida) → 500 sem vazar', async () => {
    const err = new Error('invalid key');
    err.status = 401;
    __setClientForTests(makeClientThatThrows(err));

    await assert.rejects(
      transcribeAndExtract({
        audioBuffer: WEBM_BUFFER,
        mimeType: 'audio/webm',
        modalidade: 'jiu_jitsu',
      }),
      (e) => e.status === 500,
    );
  });
});

describe('transcribeAndExtract — guardas pré-LLM', () => {
  beforeEach(() => __resetClientForTests());
  afterEach(() => __resetClientForTests());

  it('áudio não reconhecido (magic byte falha) → 415 SEM chamar LLM', async () => {
    let called = false;
    __setClientForTests({
      messages: { create: async () => { called = true; return { content: [] }; } },
    });

    await assert.rejects(
      transcribeAndExtract({
        audioBuffer: GARBAGE_BUFFER,
        mimeType: 'audio/webm',
        modalidade: 'jiu_jitsu',
      }),
      (e) => e.status === 415,
    );
    assert.equal(called, false, 'LLM não deve ser chamado se magic byte falha');
  });

  it('buffer vazio → 400', async () => {
    await assert.rejects(
      transcribeAndExtract({
        audioBuffer: Buffer.alloc(0),
        mimeType: 'audio/webm',
        modalidade: 'jiu_jitsu',
      }),
      (e) => e.status === 400,
    );
  });

  it('modalidade não suportada → 400', async () => {
    await assert.rejects(
      transcribeAndExtract({
        audioBuffer: WEBM_BUFFER,
        mimeType: 'audio/webm',
        modalidade: 'corrida',
      }),
      (e) => e.status === 400,
    );
  });
});
