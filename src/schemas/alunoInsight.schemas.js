import { z } from 'zod';

// PR #32 — Aluno Weekly Check-in (Sprint 12).
//
// OUTPUT do LLM via tool submit_insight. Defesa estrutural:
//   - summary min 40 chars força conteúdo real (impede LLM cuspir "ok.").
//   - summary max 400 chars trava verborragia.
//   - destaques max 3 itens, cada um 10-100 chars.
//   - .strict() bloqueia campos extras (anti storage poisoning).

export const insightResultSchema = z
  .object({
    summary: z.string().min(40).max(400),
    destaques: z.array(z.string().min(10).max(100)).max(3).default([]),
  })
  .strict();

export const TTL_DAYS = 7;
export const REFRESH_LIMIT_PER_WEEK = 2;
