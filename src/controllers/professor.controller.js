import { z } from 'zod';

import {
  listAlunosVinculados,
  vincularPorEmail,
  desvincular,
  detalheAluno,
  dashboardProfessor,
} from '../services/professor.service.js';
import { HttpError } from '../middleware/errorHandler.js';

const vincularSchema = z.object({
  email: z.string().email('Email inválido').toLowerCase().trim(),
});

function ensureProf(req) {
  if (req.user.role !== 'PROFESSOR') throw new HttpError(403, 'Apenas professores');
}

export async function alunos(req, res, next) {
  try {
    ensureProf(req);
    const list = await listAlunosVinculados(req.user.userId);
    res.json({ alunos: list });
  } catch (err) {
    next(err);
  }
}

export async function vincular(req, res, next) {
  try {
    ensureProf(req);
    const { email } = vincularSchema.parse(req.body);
    const novo = await vincularPorEmail(req.user.userId, email);
    res.status(201).json({ aluno: novo });
  } catch (err) {
    next(err);
  }
}

export async function removerVinculo(req, res, next) {
  try {
    ensureProf(req);
    const result = await desvincular(req.user.userId, req.params.vinculoId);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function alunoDetalhe(req, res, next) {
  try {
    ensureProf(req);
    const data = await detalheAluno(req.user.userId, req.params.alunoId);
    res.json(data);
  } catch (err) {
    next(err);
  }
}

export async function dashboard(req, res, next) {
  try {
    ensureProf(req);
    const stats = await dashboardProfessor(req.user.userId);
    res.json(stats);
  } catch (err) {
    next(err);
  }
}
