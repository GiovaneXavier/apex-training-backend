import { z } from 'zod';

export const DiaSemana = z.enum(['DOM', 'SEG', 'TER', 'QUA', 'QUI', 'SEX', 'SAB']);

const rotinaExercicioInput = z.object({
  exercicioId: z.string().min(1),
  ordem: z.number().int().min(0),
  series: z.number().int().positive(),
  reps: z.number().int().positive().optional(),
  repsMin: z.number().int().positive().optional(),
  repsMax: z.number().int().positive().optional(),
  cargaPctRP: z.number().min(0).max(200).optional(),
  cargaKg: z.number().nonnegative().optional(),
  descansoSeg: z.number().int().nonnegative().optional(),
  observacao: z.string().max(500).optional(),
});

export const rotinaCreateSchema = z.object({
  alunoId: z.string().min(1),
  nome: z.string().min(1).max(120).trim(),
  diaSemana: DiaSemana,
  vigenciaInicio: z.string().datetime(),
  vigenciaFim: z.string().datetime().optional().nullable(),
  exercicios: z.array(rotinaExercicioInput).min(1),
});

export const rotinaUpdateSchema = z.object({
  nome: z.string().min(1).max(120).trim().optional(),
  diaSemana: DiaSemana.optional(),
  vigenciaInicio: z.string().datetime().optional(),
  vigenciaFim: z.string().datetime().nullable().optional(),
  exercicios: z.array(rotinaExercicioInput).min(1).optional(),
});

export const rotinaListQuery = z.object({
  alunoId: z.string().optional(),
  diaSemana: DiaSemana.optional(),
  ativasEm: z.string().datetime().optional(), // filtra rotinas vigentes nessa data
});

export const reagendarTreinoSchema = z.object({
  novaDataAlvo: z.string().datetime(),
});
