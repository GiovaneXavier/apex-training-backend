import {
  listarVinculosNutri,
  aceitarVinculoNutri,
  recusarVinculoNutri,
  listarVinculosProfessor,
} from '../services/aluno.service.js';
import { z } from 'zod';

import { getDesempenho, getVolumeSeries } from '../services/desempenho.service.js';

const volumeQuery = z.object({
  weeks: z.coerce.number().int().min(4).max(52).default(12),
});
import { HttpError } from '../middleware/errorHandler.js';

function ensureAluno(req) {
  if (req.user.role !== 'ALUNO') throw new HttpError(403, 'Apenas alunos');
}

export async function nutricionistas(req, res, next) {
  try {
    ensureAluno(req);
    const data = await listarVinculosNutri(req.user.userId);
    res.json({ nutricionistas: data });
  } catch (err) {
    next(err);
  }
}

export async function aceitarNutri(req, res, next) {
  try {
    ensureAluno(req);
    const result = await aceitarVinculoNutri(req.user.userId, req.params.vinculoId);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function recusarNutri(req, res, next) {
  try {
    ensureAluno(req);
    const result = await recusarVinculoNutri(req.user.userId, req.params.vinculoId);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function professores(req, res, next) {
  try {
    ensureAluno(req);
    const data = await listarVinculosProfessor(req.user.userId);
    res.json({ professores: data });
  } catch (err) {
    next(err);
  }
}

// Desempenho agregado — qualquer role autenticado, com vínculo
// (validação fica no service). Aceita alunoId opcional via params.
export async function desempenho(req, res, next) {
  try {
    const data = await getDesempenho({
      user: req.user,
      alunoId: req.params.alunoId,
    });
    res.json(data);
  } catch (err) {
    next(err);
  }
}

// PR #20 — Matriz de Volume Semanal. Devolve série temporal por
// modalidade pro gráfico. Acesso via guardião canônico igual ao
// desempenho (read).
export async function volume(req, res, next) {
  try {
    const { weeks } = volumeQuery.parse(req.query);
    const data = await getVolumeSeries({
      user: req.user,
      alunoId: req.params.alunoId,
      weeks,
    });
    res.json(data);
  } catch (err) {
    next(err);
  }
}
