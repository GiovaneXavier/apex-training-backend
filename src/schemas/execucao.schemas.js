import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────
// Caps de segurança (anti-DoS / anti-OOM) — PR #11
//
// Por que: detalhes vão pra coluna jsonb e ficam carregados em memória
// em endpoints de histórico/dashboard. Sem caps, um payload malicioso
// (ou bugado em cliente) pode estourar memória do node e bloar o DB.
//
// Os limites abaixo são *generosos* para uso real, mas finitos:
//   - sets por exercício: 20 (sessão real raramente passa de 8-10)
//   - exercícios por execução: 50 (treino A+B+C juntos cabe)
//   - kg máx por set: 2000 (deadlift WR ~500kg; 2000 absorve outliers/erros)
//   - reps máx por set: 10000 (AMRAP teórico, evita Number overflow)
// ─────────────────────────────────────────────────────────────────────

const MAX_SETS_POR_EXERCICIO = 20;
const MAX_EXERCICIOS_POR_EXEC = 50;
const MAX_BLOCOS_REALIZADO = 20;
const MAX_KG = 2000;
const MAX_REPS = 10000;
const MAX_DURACAO_SEG = 86400 * 3; // 3 dias — cobre ironman + folga

// ─── Musculação ──────────────────────────────────────────────────────
// .strict() em set bloqueia atributos extras: cliente que mande
// `{ kg, reps, gpsLatitude }` recebe 400 em vez de gravar campo lixo
// no jsonb. Defesa em profundidade pra evitar storage poisoning.
const setRealizadoSchema = z
  .object({
    kg: z.number().nonnegative().max(MAX_KG).optional(),
    reps: z.number().int().nonnegative().max(MAX_REPS).optional(),
    rpe: z.number().min(0).max(10).optional(),
    observacao: z.string().max(200).optional(),
    registradoEm: z.string().datetime().optional(),
  })
  .strict();

const exercicioRealizadoSchema = z
  .object({
    nome: z.string().min(1).max(120),
    realizado: z.array(setRealizadoSchema).max(MAX_SETS_POR_EXERCICIO).default([]),
  })
  .strict();

// Schema de primeira passada — controller usa direto no req.body.
// O `realizado` aqui é generoso (record unknown) porque o serviço
// faz uma SEGUNDA passada estrita usando o schema-por-modalidade
// abaixo, decidido pelo `treino.detalhes.tipo` carregado do DB.
// Esse two-pass evita ter que descobrir o tipo antes do parse.
export const salvarExecucaoSchema = z
  .object({
    exercicios: z.array(exercicioRealizadoSchema).max(MAX_EXERCICIOS_POR_EXEC).optional(),
    realizado: z.record(z.unknown()).optional(),
    status: z.enum(['CONCLUIDO', 'PULADO']).default('CONCLUIDO'),
    finalizadoEm: z.string().datetime().optional(),
  })
  .strict();

// ─── Schemas estritos do `realizado` por modalidade ──────────────────
// Estes são consumidos pelo service após carregar `treino.detalhes.tipo`.
// Cada um termina em .strict() — campos desconhecidos viram ValidationError.

const realizadoCorridaSchema = z
  .object({
    distanciaKm: z.number().nonnegative().max(500).optional(),
    duracaoSeg: z.number().int().nonnegative().max(MAX_DURACAO_SEG).optional(),
    ritmoMedioMinKm: z
      .string()
      .max(10)
      .regex(/^\d{1,2}:\d{2}$/, 'Formato MM:SS')
      .optional(),
    fcMedia: z.number().int().nonnegative().max(250).optional(),
    stravaActivityId: z.string().max(64).optional(),
    observacao: z.string().max(500).optional(),
  })
  .strict();

const realizadoCiclismoSchema = z
  .object({
    distanciaKm: z.number().nonnegative().max(1000).optional(),
    duracaoSeg: z.number().int().nonnegative().max(MAX_DURACAO_SEG).optional(),
    potenciaMediaW: z.number().nonnegative().max(3000).optional(),
    potenciaNormalizadaW: z.number().nonnegative().max(3000).optional(),
    cadenciaMediaRpm: z.number().int().nonnegative().max(250).optional(),
    fcMedia: z.number().int().nonnegative().max(250).optional(),
    stravaActivityId: z.string().max(64).optional(),
    observacao: z.string().max(500).optional(),
  })
  .strict();

const realizadoNatacaoSchema = z
  .object({
    distanciaTotalM: z.number().nonnegative().max(50000).optional(),
    duracaoSeg: z.number().int().nonnegative().max(MAX_DURACAO_SEG).optional(),
    paceMedioSegPor100m: z.number().nonnegative().max(3600).optional(),
    observacao: z.string().max(500).optional(),
  })
  .strict();

const realizadoHyroxBlocoSchema = z
  .object({
    formato: z.string().max(40).optional(),
    duracaoSeg: z.number().int().nonnegative().max(MAX_DURACAO_SEG).optional(),
    rounds: z.number().int().nonnegative().max(100).optional(),
    repeticoes: z.number().int().nonnegative().max(MAX_REPS).optional(),
    observacao: z.string().max(300).optional(),
  })
  .strict();

const realizadoHyroxSchema = z
  .object({
    duracaoTotalSeg: z.number().int().nonnegative().max(MAX_DURACAO_SEG).optional(),
    rounds: z.number().int().nonnegative().max(100).optional(),
    blocos: z.array(realizadoHyroxBlocoSchema).max(MAX_BLOCOS_REALIZADO).optional(),
    observacao: z.string().max(500).optional(),
  })
  .strict();

const realizadoTriathlonSchema = z
  .object({
    duracaoTotalSeg: z.number().int().nonnegative().max(MAX_DURACAO_SEG).optional(),
    natacao: realizadoNatacaoSchema.optional(),
    ciclismo: realizadoCiclismoSchema.optional(),
    corrida: realizadoCorridaSchema.optional(),
    observacao: z.string().max(500).optional(),
  })
  .strict();

// ─── Jiu-Jitsu (PR #23) ──────────────────────────────────────────────
//
// Diário de tatame. 5 campos numéricos compactos pra preenchimento
// fricção-zero no pós-rola — atleta suado/cansado, UI vai usar +/- e
// slider.
//
// Caps de domínio:
//   - matTimeSegundos: 14_400s = 4h. Aulas de BJJ raramente passam de
//     2h; 4h cobre seminário/imersão sem virar vetor de abuso.
//   - roundsCompletos / finalizacoes*: 0..50. Champion rola muito,
//     mas 50 rolas num único treino é cap absurdo (1 rola = ~5min,
//     50 = 4h+ rolando, já bate no matTime cap).
//   - readinessRating: 1..10 integer. Slider único combina sono +
//     fadiga + humor — fricção mínima vs 3 sliders separados.
//
// `.strict()` ativo: campo desconhecido rejeitado antes de gravar no
// jsonb. UI/clientes terceiros não conseguem injetar "freeText" gigante
// disfarçado de observação.
const MAX_ROUNDS_JIU_JITSU = 50;
const MAX_FINALIZACOES = 50;
const MAX_MAT_TIME_SEG = 14_400; // 4h

const realizadoJiuJitsuSchema = z
  .object({
    matTimeSegundos: z.number().int().nonnegative().max(MAX_MAT_TIME_SEG).optional(),
    roundsCompletos: z.number().int().nonnegative().max(MAX_ROUNDS_JIU_JITSU).optional(),
    finalizacoesFeitas: z.number().int().nonnegative().max(MAX_FINALIZACOES).optional(),
    finalizacoesSofridas: z.number().int().nonnegative().max(MAX_FINALIZACOES).optional(),
    readinessRating: z.number().int().min(1).max(10).optional(),
    observacao: z.string().max(500).optional(),
  })
  .strict();

// `outro` aceita string OU objeto solto (uso livre). Mantém cap rígido.
const realizadoOutroSchema = z.union([
  z.string().max(2000),
  z
    .object({
      descricao: z.string().max(2000).optional(),
      duracaoSeg: z.number().int().nonnegative().max(MAX_DURACAO_SEG).optional(),
      observacao: z.string().max(500).optional(),
    })
    .strict(),
]);

// ─── Router ──────────────────────────────────────────────────────────
// Mapeia o discriminador `tipo` (vem do jsonb gravado na prescrição,
// validado por treino.schemas.treinoDetalhes) para o schema estrito do
// `realizado`. Retorna null pra musculação — esta usa `exercicios[]`,
// não `realizado`; o serviço trata como caso especial.
const SCHEMA_POR_TIPO = {
  corrida: realizadoCorridaSchema,
  ciclismo: realizadoCiclismoSchema,
  natacao: realizadoNatacaoSchema,
  hyrox: realizadoHyroxSchema,
  triathlon: realizadoTriathlonSchema,
  jiu_jitsu: realizadoJiuJitsuSchema,
  outro: realizadoOutroSchema,
};

export function getRealizadoSchemaPorTipo(tipo) {
  return SCHEMA_POR_TIPO[tipo] ?? null;
}

// Exportados para testes e introspecção.
export const LIMITES_EXECUCAO = Object.freeze({
  MAX_SETS_POR_EXERCICIO,
  MAX_EXERCICIOS_POR_EXEC,
  MAX_BLOCOS_REALIZADO,
  MAX_KG,
  MAX_REPS,
  MAX_DURACAO_SEG,
  MAX_ROUNDS_JIU_JITSU,
  MAX_FINALIZACOES,
  MAX_MAT_TIME_SEG,
});
