import { z } from 'zod';

// PR #22 — Zod alinhado com o enum Prisma. HYROX existia no schema do
// banco e nos detalhesHyrox mas faltava aqui (drift desde o PR #14).
// Agora pareado: enum SQL e enum Zod 1:1.
export const Modalidade = z.enum([
  'MUSCULACAO',
  'CORRIDA',
  'CICLISMO',
  'NATACAO',
  'TRIATHLON',
  'HYROX',
  'JIU_JITSU',
  'OUTRO',
]);

export const StatusTreino = z.enum(['PENDENTE', 'EM_EXECUCAO', 'CONCLUIDO', 'PULADO']);

// ─────────────────────────────────────────────────────────────
// MUSCULAÇÃO
// ─────────────────────────────────────────────────────────────
const exercicioPrescrito = z.object({
  series: z.number().int().positive(),
  reps: z.number().int().positive().optional(),
  repsMin: z.number().int().positive().optional(),
  repsMax: z.number().int().positive().optional(),
  cargaPctRP: z.number().min(0).max(200).optional(),
  cargaKg: z.number().nonnegative().optional(),
  descansoSeg: z.number().int().nonnegative().optional(),
  observacao: z.string().max(500).optional(),
});

const setRealizado = z.object({
  kg: z.number().nonnegative().optional(),
  reps: z.number().int().nonnegative().optional(),
  rpe: z.number().min(0).max(10).optional(),
  observacao: z.string().max(200).optional(),
  registradoEm: z.string().datetime().optional(),
});

const exercicioMusc = z.object({
  nome: z.string().min(1).max(120),
  videoUrl: z.string().url().optional(),
  prescrito: exercicioPrescrito,
  realizado: z.array(setRealizado).optional().default([]),
  observacao: z.string().max(500).optional(),
});

export const detalhesMusculacao = z.object({
  tipo: z.literal('musculacao'),
  exercicios: z.array(exercicioMusc).min(1),
  observacao: z.string().max(500).optional(),
});

// ─────────────────────────────────────────────────────────────
// CORRIDA
// ─────────────────────────────────────────────────────────────
const corridaSubtipo = z.enum([
  'BASE', 'RECOVERY', 'LONG', 'PROGRESSION',
  'INTERVALOS', 'TEMPO', 'THRESHOLD', 'FARTLEK', 'HILL_REPEATS',
]);

const corridaBlocoTipo = z.enum([
  'aquecimento', 'tiro', 'recuperacao', 'volta_calma',
  'continuo', 'progressao', 'subida',
]);

const corridaBloco = z.object({
  tipo: corridaBlocoTipo,
  distanciaM: z.number().positive().optional(),
  duracaoSeg: z.number().int().positive().optional(),
  ritmoAlvoMinKm: z.string().regex(/^\d{1,2}:\d{2}$/, 'Formato MM:SS').optional(),
  fcAlvoMin: z.number().int().positive().optional(),
  fcAlvoMax: z.number().int().positive().optional(),
  zonaFC: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]).optional(),
  rpeAlvo: z.number().min(1).max(10).optional(),
  repeticoes: z.number().int().positive().optional(),
  recuperacaoSeg: z.number().int().nonnegative().optional(),
  recuperacaoTipo: z.enum(['trote', 'caminhada', 'parado']).optional(),
  observacao: z.string().max(300).optional(),
});

export const detalhesCorrida = z.object({
  tipo: z.literal('corrida'),
  subtipo: corridaSubtipo.optional(),
  distanciaKm: z.number().positive().optional(),
  ritmoAlvoMinKm: z.string().regex(/^\d{1,2}:\d{2}$/, 'Formato MM:SS').optional(),
  fcAlvoMin: z.number().int().positive().optional(),
  fcAlvoMax: z.number().int().positive().optional(),
  blocos: z.array(corridaBloco).optional(),
  realizado: z.object({
    distanciaKm: z.number().nonnegative().optional(),
    duracaoSeg: z.number().int().nonnegative().optional(),
    ritmoMedioMinKm: z.string().optional(),
    fcMedia: z.number().int().nonnegative().optional(),
    stravaActivityId: z.string().optional(),
  }).nullable().optional(),
  observacao: z.string().max(500).optional(),
});

// ─────────────────────────────────────────────────────────────
// CICLISMO — zonas FTP
// ─────────────────────────────────────────────────────────────
const zonaFTP = z.union([
  z.literal(1), z.literal(2), z.literal(3), z.literal(4),
  z.literal(5), z.literal(6), z.literal(7),
]);

const ciclismoBloco = z.object({
  tipo: z.enum(['aquecimento', 'intervalo', 'recuperacao', 'continuo', 'volta_calma', 'sprint']),
  zonaFTP: zonaFTP.optional(),
  potenciaAlvoW: z.number().nonnegative().optional(),
  potenciaAlvoPctFTP: z.number().min(0).max(300).optional(),
  cadenciaRpm: z.number().int().min(0).max(250).optional(),
  duracaoSeg: z.number().int().positive().optional(),
  distanciaKm: z.number().positive().optional(),
  repeticoes: z.number().int().positive().optional(),
  recuperacaoSeg: z.number().int().nonnegative().optional(),
  observacao: z.string().max(300).optional(),
});

export const detalhesCiclismo = z.object({
  tipo: z.literal('ciclismo'),
  ftpW: z.number().positive().optional(),
  distanciaKm: z.number().positive().optional(),
  duracaoMin: z.number().positive().optional(),
  potenciaAlvoW: z.number().nonnegative().optional(),
  blocos: z.array(ciclismoBloco).optional(),
  realizado: z.object({
    distanciaKm: z.number().nonnegative().optional(),
    duracaoSeg: z.number().int().nonnegative().optional(),
    potenciaMediaW: z.number().nonnegative().optional(),
    potenciaNormalizadaW: z.number().nonnegative().optional(),
    stravaActivityId: z.string().optional(),
  }).nullable().optional(),
  observacao: z.string().max(500).optional(),
});

// ─────────────────────────────────────────────────────────────
// NATAÇÃO — CSS
// ─────────────────────────────────────────────────────────────
const estiloNado = z.enum(['LIVRE', 'COSTAS', 'PEITO', 'BORBOLETA', 'MEDLEY']);

const natacaoBloco = z.object({
  tipo: z.enum(['aquecimento', 'principal', 'tecnica', 'volta_calma']),
  repeticoes: z.number().int().positive(),
  distanciaM: z.number().positive(),
  estilo: estiloNado.optional(),
  paceAlvoSegPor100m: z.number().positive().optional(),
  paceCssOffsetSeg: z.number().optional(),
  descansoSeg: z.number().int().nonnegative().optional(),
  sendOffSeg: z.number().int().positive().optional(),
  equipamento: z.array(z.enum(['palmar', 'pull_buoy', 'pe_de_pato', 'snorkel', 'prancha'])).optional(),
  observacao: z.string().max(300).optional(),
});

export const detalhesNatacao = z.object({
  tipo: z.literal('natacao'),
  cssBaseSegPor100m: z.number().positive().optional(),
  series: z.array(z.object({
    repeticoes: z.number().int().positive(),
    distanciaM: z.number().positive(),
    estilo: estiloNado.optional(),
    descansoSeg: z.number().int().nonnegative().optional(),
  })).optional(),
  blocos: z.array(natacaoBloco).optional(),
  realizado: z.object({
    distanciaTotalM: z.number().nonnegative().optional(),
    duracaoSeg: z.number().int().nonnegative().optional(),
    observacao: z.string().max(300).optional(),
  }).nullable().optional(),
});

// ─────────────────────────────────────────────────────────────
// HYROX / Híbrido
// ─────────────────────────────────────────────────────────────
const hyroxFormato = z.enum([
  'AMRAP', 'EMOM', 'FOR_TIME', 'TABATA', 'INTERVAL', 'RUN', 'STATION',
]);

const hyroxMov = z.enum([
  'SKI_ERG', 'SLED_PUSH', 'SLED_PULL', 'BURPEE_BROAD_JUMP', 'ROWING',
  'FARMERS_CARRY', 'SANDBAG_LUNGES', 'WALL_BALLS', 'RUN', 'BIKE_ERG',
  'AIR_SQUAT', 'KETTLEBELL_SWING', 'BOX_JUMP', 'OUTRO',
]);

const hyroxCarga = z.object({
  open: z.number().nonnegative().optional(),
  pro: z.number().nonnegative().optional(),
  unidade: z.enum(['kg', 'lb']).default('kg').optional(),
});

const hyroxExercicio = z.object({
  movimento: hyroxMov,
  nome: z.string().max(120).optional(),
  distanciaM: z.number().positive().optional(),
  repeticoes: z.number().int().positive().optional(),
  duracaoSeg: z.number().int().positive().optional(),
  carga: hyroxCarga.optional(),
  observacao: z.string().max(300).optional(),
});

const hyroxBloco = z.object({
  formato: hyroxFormato,
  duracaoSeg: z.number().int().positive().optional(),
  rounds: z.number().int().positive().optional(),
  intervaloOnSeg: z.number().int().positive().optional(),
  intervaloOffSeg: z.number().int().nonnegative().optional(),
  distanciaM: z.number().positive().optional(),
  ritmoAlvoMinKm: z.string().regex(/^\d{1,2}:\d{2}$/).optional(),
  exercicios: z.array(hyroxExercicio).optional(),
  descansoEntreSeg: z.number().int().nonnegative().optional(),
  observacao: z.string().max(300).optional(),
});

export const detalhesHyrox = z.object({
  tipo: z.literal('hyrox'),
  blocos: z.array(hyroxBloco).min(1),
  observacao: z.string().max(500).optional(),
});

// ─────────────────────────────────────────────────────────────
// TRIATHLON / OUTRO
// ─────────────────────────────────────────────────────────────
export const detalhesTriathlon = z.object({
  tipo: z.literal('triathlon'),
  blocos: z.array(z.discriminatedUnion('tipo', [
    detalhesNatacao, detalhesCiclismo, detalhesCorrida,
  ])).min(2),
  observacao: z.string().max(500).optional(),
});

export const detalhesOutro = z.object({
  tipo: z.literal('outro'),
  descricao: z.string().min(1).max(2000),
  realizado: z.string().max(2000).nullable().optional(),
});

// ─────────────────────────────────────────────────────────────
// JIU-JITSU (PR #23)
//
// Prescrição do BJJ: aquecimento livre, drills (referência a movimentos
// do catálogo Exercicio via nome — Movimento ficou no Exercicio do PR #22),
// rolas (rounds × tempo). O `realizado` fica do lado do execucao.schemas
// (jiuJitsuRealizadoSchema) — espelha o pattern Corrida.
// ─────────────────────────────────────────────────────────────
const jiuJitsuAquecimentoSchema = z.object({
  nome: z.string().min(1).max(120),
  duracaoSeg: z.number().int().positive().max(3600).optional(),
  observacao: z.string().max(300).optional(),
});

const jiuJitsuDrillSchema = z.object({
  // `movimento` referencia Exercicio.nome (texto livre — snapshot do
  // catálogo no momento da prescrição). Mesmo pattern do musculacao.
  movimento: z.string().min(1).max(120),
  reps: z.number().int().positive().max(200).optional(),
  duracaoSeg: z.number().int().positive().max(3600).optional(),
  observacao: z.string().max(300).optional(),
});

const jiuJitsuRolasSchema = z.object({
  rounds: z.number().int().positive().max(50),
  tempoRoundSeg: z.number().int().positive().max(1800), // 30min/round max
  descansoSeg: z.number().int().nonnegative().max(600).optional(),
  observacao: z.string().max(300).optional(),
});

export const detalhesJiuJitsu = z.object({
  tipo: z.literal('jiu_jitsu'),
  aquecimento: z.array(jiuJitsuAquecimentoSchema).max(10).optional(),
  drills: z.array(jiuJitsuDrillSchema).max(20).optional(),
  rolas: jiuJitsuRolasSchema.optional(),
  observacao: z.string().max(500).optional(),
});

// Discriminated union — superpoder do JSON.
export const treinoDetalhes = z.discriminatedUnion('tipo', [
  detalhesMusculacao,
  detalhesCorrida,
  detalhesCiclismo,
  detalhesNatacao,
  detalhesTriathlon,
  detalhesHyrox,
  detalhesJiuJitsu,
  detalhesOutro,
]);

// ─────────────────────────────────────────────────────────────
// Schemas de entidade
// ─────────────────────────────────────────────────────────────
export const prescreverSchema = z.object({
  alunoId: z.string().min(1),
  modalidade: Modalidade,
  titulo: z.string().min(1).max(200).trim(),
  dataAlvo: z.string().datetime(),
  detalhes: treinoDetalhes,
});

// PR #16 — janela para `dataAlvo` no clone. Mais ampla que iniciar
// (rotinas), pois clonar é prescrição: prof pode agendar treino pra
// semana futura ou registrar lote retroativo após reset.
//   - até  +180 dias no futuro (1 trimestre de pré-prescrição)
//   - até  -90 dias no passado  (lote de catch-up)
const CLONE_FUT_MS = 180 * 24 * 60 * 60 * 1000;
const CLONE_PAS_MS = 90 * 24 * 60 * 60 * 1000;

export const clonarTreinoSchema = z.object({
  dataAlvo: z
    .string()
    .datetime()
    .refine((iso) => {
      const t = new Date(iso).getTime();
      const agora = Date.now();
      return t <= agora + CLONE_FUT_MS && t >= agora - CLONE_PAS_MS;
    }, 'dataAlvo fora da janela permitida (-90 dias até +180 dias do agora)'),
});

export const listTreinosQuery = z.object({
  status: StatusTreino.optional(),
  desde: z.string().datetime().optional(),
  ate: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
