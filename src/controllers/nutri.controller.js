import { z } from 'zod';

import {
  listAlunosVinculados,
  solicitarVinculoPorEmail,
  desvincular,
  detalheAluno,
} from '../services/nutri.service.js';
import { HttpError } from '../middleware/errorHandler.js';

const solicitarSchema = z.object({
  email: z.string().email('Email inválido').toLowerCase().trim(),
});

function ensureNutri(req) {
  if (req.user.role !== 'NUTRICIONISTA') throw new HttpError(403, 'Apenas nutricionistas');
}

export async function alunos(req, res, next) {
  try {
    ensureNutri(req);
    const data = await listAlunosVinculados(req.user.userId);
    res.json({ alunos: data });
  } catch (err) {
    next(err);
  }
}

export async function solicitar(req, res, next) {
  try {
    ensureNutri(req);
    const { email } = solicitarSchema.parse(req.body);
    const v = await solicitarVinculoPorEmail(req.user.userId, email);
    res.status(201).json({ vinculo: v });
  } catch (err) {
    next(err);
  }
}

export async function removerVinculo(req, res, next) {
  try {
    ensureNutri(req);
    const result = await desvincular(req.user.userId, req.params.vinculoId);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function alunoDetalhe(req, res, next) {
  try {
    ensureNutri(req);
    const data = await detalheAluno(req.user.userId, req.params.alunoId);
    res.json(data);
  } catch (err) {
    next(err);
  }
}
