import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';

import { env } from '../lib/env.js';
import { HttpError } from '../middleware/errorHandler.js';
import { getRealizadoSchemaPorTipo } from '../schemas/execucao.schemas.js';
import { voiceExtractSchema } from '../schemas/voice.schemas.js';

// PR #25 — Diário de Voz com IA.
//
// Responsabilidade: receber buffer de áudio + modalidade, devolver JSON
// estruturado pré-validado contra o schema Zod canônico da modalidade.
//
// Decisões:
//
//  - Provider único (Anthropic Claude) com tool_use pra extração
//    estruturada. JSON-mode free-form gera mais alucinação que
//    tool input_schema com tipos explícitos.
//
//  - Áudio NÃO persiste em disco/S3. Buffer in-memory → request →
//    descarta. LGPD-friendly.
//
//  - Magic bytes detection antes de chamar o LLM. Mime do multipart é
//    user-controlled e iOS mente — confiar só nele permite payload
//    arbitrário disfarçado de áudio.
//
//  - Idempotente do ponto de vista do servidor: nada persiste aqui,
//    cliente é fonte da verdade. Re-submit não duplica nada.
//
// O cliente Anthropic é singleton lazy — instanciar no boot quebra
// testes que não setam a key. Construído na primeira chamada.

let _client = null;
function getClient() {
  if (_client) return _client;
  if (!env.ANTHROPIC_API_KEY) {
    throw new HttpError(503, 'Diário de voz indisponível (feature off)');
  }
  _client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  return _client;
}

// Hook pra testes — injeta cliente mock sem mexer em env real.
export function __setClientForTests(client) {
  _client = client;
}
export function __resetClientForTests() {
  _client = null;
}

// ─── Magic bytes ─────────────────────────────────────────────────────
// Verifica que o buffer começa com header conhecido de container de
// áudio/vídeo. Lista paralela à AUDIO_MIME_ALLOWLIST do schema.
//
// Refs:
//   webm/matroska   1A 45 DF A3
//   ogg             4F 67 67 53 ("OggS")
//   mp4/m4a         offset 4: 66 74 79 70 ("ftyp")
//   adts aac        FF F1 ou FF F9 (sync word)
//   mp3             FF Fx ou 49 44 33 ("ID3")

const MAGIC_CHECKS = [
  { name: 'webm', test: (b) => b.length >= 4 && b[0] === 0x1A && b[1] === 0x45 && b[2] === 0xDF && b[3] === 0xA3 },
  { name: 'ogg', test: (b) => b.length >= 4 && b[0] === 0x4F && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53 },
  { name: 'mp4', test: (b) => b.length >= 8 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70 },
  { name: 'aac', test: (b) => b.length >= 2 && b[0] === 0xFF && (b[1] === 0xF1 || b[1] === 0xF9) },
  { name: 'mp3', test: (b) => b.length >= 3 && ((b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) || (b[0] === 0xFF && (b[1] & 0xE0) === 0xE0)) },
];

export function detectAudioContainer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;
  for (const check of MAGIC_CHECKS) {
    if (check.test(buffer)) return check.name;
  }
  return null;
}

// ─── Prompt + tool definition ────────────────────────────────────────
// System prompt fica cached na request — system+tool são determinísticos,
// só audio_url muda. Cache hit derruba latência e custo por ~80% em
// chamadas subsequentes do mesmo user (dentro do TTL de 5 min do cache).

const SYSTEM_PROMPT_BJJ = `Você é um assistente que extrai dados estruturados de relatos de treino de Jiu-Jitsu Brasileiro em português do Brasil.

O atleta acabou de rolar e está ditando um relato curto. Sua tarefa é extrair os campos numéricos relevantes e chamar a tool "submit_bjj_data".

Regras estritas:
- matTimeSegundos: tempo total no tatame, EM SEGUNDOS (converta "25 minutos" → 1500, "1 hora e 15" → 4500).
- roundsCompletos: número de rolas/rounds completos (0–50). "Rolei 5 vezes" = 5.
- finalizacoesFeitas: finalizações que o atleta APLICOU (passou no oponente).
- finalizacoesSofridas: finalizações que o atleta SOFREU (caiu pra alguém).
- readinessRating: nota 1–10 (inteiro) de sensação geral (cansaço, sono, humor). Se não dito, omita.
- observacao: texto curto (máx 500 chars) com qualquer comentário qualitativo (técnica trabalhada, dor, parceiro, etc).
- confidence: 0.0–1.0 — sua confiança na extração. Use <0.6 se o áudio for ambíguo, com piada, ou claramente off-topic.

Se um campo não foi mencionado, OMITA-O. Não invente valores. Não use 0 como default.
Se o áudio for irrelevante (música, silêncio, fala sem nada de BJJ), retorne só { confidence: 0, observacao: "audio não reconhecido como diário de treino" }.

O input é áudio puro, independente da extensão do arquivo.`;

const TOOL_DEF_BJJ = {
  name: 'submit_bjj_data',
  description: 'Submete os dados extraídos do diário de voz do treino de Jiu-Jitsu.',
  input_schema: {
    type: 'object',
    properties: {
      matTimeSegundos: { type: 'integer', minimum: 0, maximum: 14400, description: 'Tempo total no tatame em segundos' },
      roundsCompletos: { type: 'integer', minimum: 0, maximum: 50 },
      finalizacoesFeitas: { type: 'integer', minimum: 0, maximum: 50 },
      finalizacoesSofridas: { type: 'integer', minimum: 0, maximum: 50 },
      readinessRating: { type: 'integer', minimum: 1, maximum: 10 },
      observacao: { type: 'string', maxLength: 500 },
      confidence: { type: 'number', minimum: 0, maximum: 1, description: 'Confiança na extração; <0.6 = needs review' },
    },
    additionalProperties: false,
  },
};

// ─── Service principal ───────────────────────────────────────────────

/**
 * Transcreve e extrai JSON estruturado do áudio.
 *
 * @param {object} args
 * @param {Buffer} args.audioBuffer  Buffer in-memory (do multer).
 * @param {string} args.mimeType     Mime declarado pelo cliente (sanity-check).
 * @param {'jiu_jitsu'} args.modalidade  Por enquanto só BJJ.
 *
 * @returns {Promise<{fields: object, transcript: string|null, confidence: number, needsReview: boolean, warnings: string[], partial: boolean}>}
 */
export async function transcribeAndExtract({ audioBuffer, mimeType, modalidade }) {
  if (!env.voiceEnabled) {
    throw new HttpError(503, 'Diário de voz indisponível (feature off)');
  }
  if (modalidade !== 'jiu_jitsu') {
    throw new HttpError(400, `Modalidade não suportada para voz: ${modalidade}`);
  }
  if (!Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0) {
    throw new HttpError(400, 'Áudio vazio');
  }

  // Magic bytes — fail-fast antes de gastar token na Anthropic.
  const container = detectAudioContainer(audioBuffer);
  if (!container) {
    throw new HttpError(415, 'Formato de áudio não reconhecido');
  }

  const client = getClient();

  // Mapeia magic detection pra media_type aceito pela Anthropic Files
  // API. Anthropic ainda não aceita webm direto em todas as regiões; pra
  // hoje, usamos o mime declarado pelo cliente (validado pelo multer) e
  // confiamos no container check acima.
  // Quando a API audio do Claude estabilizar (preview no momento desta
  // implementação), trocaremos pelo type adequado.
  const audioMediaType = normalizeMediaType(mimeType, container);

  let toolInput;
  try {
    const response = await client.messages.create({
      model: env.ANTHROPIC_MODEL,
      max_tokens: 1024,
      system: [
        // Cache breakpoint: system prompt + tool def são estáveis, cache hit
        // em chamadas subsequentes do mesmo user reduz custo ~80%.
        { type: 'text', text: SYSTEM_PROMPT_BJJ, cache_control: { type: 'ephemeral' } },
      ],
      tools: [TOOL_DEF_BJJ],
      tool_choice: { type: 'tool', name: 'submit_bjj_data' },
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'input_audio',
              source: {
                type: 'base64',
                media_type: audioMediaType,
                data: audioBuffer.toString('base64'),
              },
            },
            {
              type: 'text',
              text: 'Extraia os dados do relato e chame a tool submit_bjj_data.',
            },
          ],
        },
      ],
    });

    const toolBlock = response.content?.find((b) => b.type === 'tool_use' && b.name === 'submit_bjj_data');
    if (!toolBlock) {
      throw new HttpError(502, 'IA não devolveu tool_use esperado');
    }
    toolInput = toolBlock.input || {};
  } catch (err) {
    if (err instanceof HttpError) throw err;
    // Timeout/network/billing — propaga 504 pra UX retomar manual.
    const message = err?.message || 'Falha ao consultar IA';
    if (err?.status === 401 || err?.status === 403) {
      throw new HttpError(500, 'Credenciais IA inválidas');
    }
    if (err?.status === 429) {
      throw new HttpError(429, 'Limite de IA atingido — tente em alguns minutos');
    }
    throw new HttpError(504, `IA indisponível: ${message}`);
  }

  // Pass 1: schema permissivo do voice (inclui confidence).
  const voiceParsed = voiceExtractSchema.safeParse(toolInput);

  // Pass 2: schema canônico da modalidade (sem confidence) — verdade final.
  const canonical = getRealizadoSchemaPorTipo(modalidade);
  const { confidence, ...candidateFields } = voiceParsed.success ? voiceParsed.data : toolInput;
  const canonParsed = canonical.safeParse(candidateFields);

  const warnings = [];
  let partial = false;
  let fields = {};

  if (canonParsed.success) {
    fields = canonParsed.data;
  } else {
    // Tenta salvamento parcial: filtra campo a campo, descarta inválidos.
    partial = true;
    for (const [key, val] of Object.entries(candidateFields)) {
      const single = canonical.safeParse({ [key]: val });
      if (single.success) {
        fields[key] = val;
      } else {
        warnings.push(`Campo "${key}" descartado: ${single.error.issues[0]?.message || 'inválido'}`);
      }
    }
  }

  if (!voiceParsed.success) {
    warnings.push('IA devolveu campos fora do schema esperado; usando filtragem parcial.');
    partial = true;
  }

  const confValue = typeof confidence === 'number' ? confidence : 1;
  const needsReview = confValue < 0.6 || partial;

  return {
    fields,
    transcript: null, // tool_use atual não devolve transcrição separada; futuro: pedir no tool
    confidence: confValue,
    needsReview,
    warnings,
    partial,
  };
}

function normalizeMediaType(declared, container) {
  // Mantém o declared se já está na allowlist canônica da Anthropic,
  // senão derruba pro container detectado.
  const safe = new Set(['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/aac', 'audio/mpeg']);
  if (declared && safe.has(declared)) return declared;
  if (declared === 'video/mp4') return 'audio/mp4'; // iOS encapsula áudio em mp4
  switch (container) {
    case 'webm': return 'audio/webm';
    case 'ogg': return 'audio/ogg';
    case 'mp4': return 'audio/mp4';
    case 'aac': return 'audio/aac';
    case 'mp3': return 'audio/mpeg';
    default: return 'audio/mp4';
  }
}
