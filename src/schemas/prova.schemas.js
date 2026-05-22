import { z } from 'zod';
import { Modalidade } from './treino.schemas.js';

// PR #37 (Sprint 14) — Race A/B/C.
export const ProvaPrioridade = z.enum(['A', 'B', 'C']);

export const alvoTempoRegex = /^\d{1,2}:\d{2}(:\d{2})?$/;

export const provaDetalhes = z
  .object({
    distanciaKm: z.number().positive().optional(),
    distanciaM: z.number().positive().optional(),
    metaTempo: z.string().regex(alvoTempoRegex, 'HH:MM:SS ou MM:SS').optional(),
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
  prioridade: ProvaPrioridade.optional().default('C'),
  alvoTempo: z.string().regex(alvoTempoRegex, 'HH:MM:SS ou MM:SS').optional(),
  local: z.string().min(1).max(200).optional(),
  detalhes: provaDetalhes.optional().default({}),
});

// PATCH /provas/:id — todos os campos opcionais. `alunoId` e `criadoEm`
// não são editáveis (cliente que tente mandar é silenciosamente dropado).
export const atualizarProvaSchema = z
  .object({
    modalidade: Modalidade.optional(),
    nome: z.string().min(1).max(200).trim().optional(),
    data: z.string().datetime().optional(),
    prioridade: ProvaPrioridade.optional(),
    arquivada: z.boolean().optional(),
    alvoTempo: z.string().regex(alvoTempoRegex, 'HH:MM:SS ou MM:SS').nullable().optional(),
    local: z.string().min(1).max(200).nullable().optional(),
    detalhes: provaDetalhes.optional(),
  })
  .strict();

// POST /provas/:id/promover — mudança explícita de prioridade.
// Endpoint dedicado deixa intenção clara nos logs e simplifica a UI
// (botão "Definir como Race A" não precisa montar payload de PATCH).
export const promoverProvaSchema = z.object({
  prioridade: ProvaPrioridade,
});

export const listProvasQuery = z.object({
  desde: z.string().datetime().optional(),
  ate: z.string().datetime().optional(),
  prioridade: ProvaPrioridade.optional(),
  incluirArquivadas: z.coerce.boolean().optional().default(false),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
