import { z } from 'zod';

import {
  connect,
  disconnect,
  status,
  syncAtividades,
  listAtividades,
} from '../services/strava.service.js';
import { HttpError } from '../middleware/errorHandler.js';

const connectSchema = z.object({
  code: z.string().min(1, 'Code obrigatório'),
});

function ensureAluno(req) {
  if (req.user.role !== 'ALUNO') throw new HttpError(403, 'Apenas alunos têm Strava');
}

export async function conectar(req, res, next) {
  try {
    ensureAluno(req);
    const { code } = connectSchema.parse(req.body);
    const result = await connect(req.user.userId, code);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function desconectar(req, res, next) {
  try {
    ensureAluno(req);
    const result = await disconnect(req.user.userId);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function obterStatus(req, res, next) {
  try {
    ensureAluno(req);
    const data = await status(req.user.userId);
    res.json(data);
  } catch (err) {
    next(err);
  }
}

export async function sincronizar(req, res, next) {
  try {
    ensureAluno(req);
    const result = await syncAtividades(req.user.userId);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function atividades(req, res, next) {
  try {
    const limit = req.query.limit ? Number(req.query.limit) : 50;
    const data = await listAtividades({
      user: req.user,
      alunoId: req.params.alunoId,
      limit,
    });
    res.json({ atividades: data });
  } catch (err) {
    next(err);
  }
}
