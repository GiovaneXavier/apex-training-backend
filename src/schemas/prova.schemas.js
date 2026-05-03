import { z } from 'zod';
import { Modalidade } from './treino.schemas.js';

export const provaDetalhes = z
  .object({
    distanciaKm: z.number().positive().optional(),
    distanciaM: z.number().positive().optional(),
    metaTempo: z.string().regex(/^\d{1,2}:\d{2}(:\d{2})?$/, 'HH:MM:SS ou MM:SS').optional(),
    local: z.string().max(200).optional(),
    notas: z.string().max(2000).optional(),
    resultado: z
      .object({
        tempo: z.string().optional(),
        posicaoCategoria: z.number().int().positive().optional(),
      })
      .nullable()
      .optional(),
  })
  .passthrough();

export const criarProvaSchema = z.object({
  alunoId: z.string().min(1).optional(),
  modalidade: Modalidade,
  nome: z.string().min(1).max(200).trim(),
  data: z.string().datetime(),
  detalhes: provaDetalhes.optional().default({}),
});

export const listProvasQuery = z.object({
  desde: z.string().datetime().optional(),
  ate: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
