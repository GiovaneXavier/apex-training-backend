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

// alunoId é OBRIGATÓRIO: o serviço usa resolveAlunoAccess para autorizar a
// leitura. Sem alunoId não há sujeito a autorizar — antes da correção do
// IDOR esta rota retornava rotinas globais para qualquer autenticado.
export const rotinaListQuery = z.object({
  alunoId: z.string().min(1, 'alunoId obrigatório'),
  diaSemana: DiaSemana.optional(),
  ativasEm: z.string().datetime().optional(), // filtra rotinas vigentes nessa data
});

export const reagendarTreinoSchema = z.object({
  novaDataAlvo: z.string().datetime(),
});

// PR #14 (audit 4.19) — janela de tolerância para `dataAlvo` do iniciar.
//
// Antes: o frontend hardcoded `setHours(7, 0, 0, 0)` → todo treino entrava
// como 7AM, independente da hora real. Atleta que treina à noite ficava
// com timestamp errado em dashboards e streak.
//
// Agora o cliente envia a hora atual do dispositivo. Backend valida que
// está dentro de uma janela razoável:
//   - até  +5 min no futuro → tolera clock drift do device (NTP off, etc).
//   - até -7 dias no passado → permite registro retroativo (atleta treinou
//     offline ontem e só conseguiu sincronizar hoje).
//
// Fora dessa janela vira 400 ValidationError. Anti-tampering simples.
const TOLERANCIA_FUTURO_MS = 5 * 60 * 1000;
const TOLERANCIA_PASSADO_MS = 7 * 24 * 60 * 60 * 1000;

export const iniciarTreinoSchema = z.object({
  dataAlvo: z
    .string()
    .datetime()
    .optional()
    .refine(
      (iso) => {
        if (!iso) return true;
        const t = new Date(iso).getTime();
        const agora = Date.now();
        return t <= agora + TOLERANCIA_FUTURO_MS && t >= agora - TOLERANCIA_PASSADO_MS;
      },
      'dataAlvo fora da janela permitida (-7 dias até +5 min do agora)',
    ),
});
