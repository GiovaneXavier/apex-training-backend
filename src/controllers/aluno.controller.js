import {
  listarVinculosNutri,
  aceitarVinculoNutri,
  recusarVinculoNutri,
  listarVinculosProfessor,
} from '../services/aluno.service.js';
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
