import { z } from 'zod';

export const AvaliadorTipo = z.enum(['ALUNO', 'NUTRICIONISTA', 'PROFESSOR']);

export const Protocolo = z.enum([
  'ALUNO_FITA',         // auto-avaliação com fita
  'ISAK_RESTRITO',      // sem cálculo de %BF (apenas medidas)
  'JP3',                // Jackson-Pollock 3 dobras
  'JP4',                // Jackson-Pollock 4 dobras
  'JP7',                // Jackson-Pollock 7 dobras
  'DURNIN_WOMERSLEY',   // Durnin & Womersley 4 dobras
  'OUTRO',
]);

// ── Auto-avaliação ────────────────────────────────────────────
const medidasAlunoSchema = z.object({
  tipo: z.literal('ALUNO_FITA'),
  cinturaCm: z.number().positive().max(250).optional(),
  quadrilCm: z.number().positive().max(250).optional(),
  bracoCm: z.number().positive().max(120).optional(),
  coxaCm: z.number().positive().max(150).optional(),
  pescocoCm: z.number().positive().max(80).optional(),
});

// ── ISAK profissional ─────────────────────────────────────────
// Dobras cutâneas — 8 sítios padrão
const dobrasSchema = z.object({
  triceps: z.number().positive().max(80).optional(),
  subescapular: z.number().positive().max(80).optional(),
  biceps: z.number().positive().max(80).optional(),
  axilarMedia: z.number().positive().max(80).optional(),
  suprailiaca: z.number().positive().max(80).optional(),
  abdominal: z.number().positive().max(80).optional(),
  coxa: z.number().positive().max(80).optional(),
  panturrilha: z.number().positive().max(80).optional(),
  // sítios adicionais comuns nas fórmulas brasileiras
  peitoral: z.number().positive().max(80).optional(),
});

// Perímetros — 5 obrigatórios + extras
const perimetrosSchema = z.object({
  braco: z.number().positive().max(120).optional(),
  cintura: z.number().positive().max(250).optional(),
  quadril: z.number().positive().max(250).optional(),
  coxa: z.number().positive().max(150).optional(),
  panturrilha: z.number().positive().max(100).optional(),
  pescoco: z.number().positive().max(80).optional(),
  antebraco: z.number().positive().max(80).optional(),
  bracoContraido: z.number().positive().max(120).optional(),
});

// Diâmetros ósseos — 2 do perfil restrito ISAK
const diametrosSchema = z.object({
  umeral: z.number().positive().max(20).optional(),
  femoral: z.number().positive().max(20).optional(),
  bistiloide: z.number().positive().max(20).optional(),
});

const medidasISAKSchema = z.object({
  tipo: z.literal('ISAK_RESTRITO'),
  dobras: dobrasSchema.optional(),
  perimetros: perimetrosSchema.optional(),
  diametros: diametrosSchema.optional(),
});

const medidasOutroSchema = z.object({
  tipo: z.literal('OUTRO'),
  notas: z.string().max(2000).optional(),
}).passthrough(); // aceita campos extras

const medidasUnion = z.discriminatedUnion('tipo', [
  medidasAlunoSchema,
  medidasISAKSchema,
  medidasOutroSchema,
]);

const fotosSchema = z.object({
  frente: z.string().url().optional().or(z.literal('').transform(() => undefined)),
  lado: z.string().url().optional().or(z.literal('').transform(() => undefined)),
  costas: z.string().url().optional().or(z.literal('').transform(() => undefined)),
  extras: z.array(z.string().url()).optional(),
});

// ── Schemas de entidade ───────────────────────────────────────
export const evolucaoCreateSchema = z.object({
  alunoId: z.string().min(1).optional(), // Aluno → null (próprio); Nutri/Prof → obrigatório
  dataAvaliacao: z.string().datetime().optional(),
  pesoKg: z.number().positive().max(500).optional(),
  alturaCm: z.number().int().positive().max(300).optional(),
  protocolo: Protocolo.optional(),
  // sexo + idade são necessários para fórmulas de %BF (não persistidos)
  sexoBio: z.enum(['M', 'F']).optional(),
  idadeAnos: z.number().int().min(5).max(120).optional(),
  medidas: medidasUnion.optional(),
  fotos: fotosSchema.optional(),
  observacoes: z.string().max(2000).optional(),
});

export const evolucaoUpdateSchema = evolucaoCreateSchema.partial();

export const evolucaoListQuery = z.object({
  alunoId: z.string().optional(),
  desde: z.string().datetime().optional(),
  ate: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
