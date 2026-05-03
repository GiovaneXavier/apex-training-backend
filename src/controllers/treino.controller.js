import { listTreinosQuery, prescreverSchema } from '../schemas/treino.schemas.js';
import { salvarExecucaoSchema } from '../schemas/execucao.schemas.js';
import {
  listTreinosByAluno,
  getTreinoById,
  prescreverTreino,
  deleteTreino,
} from '../services/treino.service.js';
import { salvarExecucao as salvarExecucaoSvc } from '../services/execucao.service.js';

export async function listByAluno(req, res, next) {
  try {
    const filters = listTreinosQuery.parse(req.query);
    const treinos = await listTreinosByAluno({
      user: req.user,
      alunoId: req.params.alunoId,
      filters,
    });
    res.json({ treinos });
  } catch (err) {
    next(err);
  }
}

export async function detalhe(req, res, next) {
  try {
    const treino = await getTreinoById({ user: req.user, treinoId: req.params.id });
    res.json({ treino });
  } catch (err) {
    next(err);
  }
}

export async function prescrever(req, res, next) {
  try {
    const data = prescreverSchema.parse(req.body);
    const treino = await prescreverTreino({ user: req.user, input: data });
    res.status(201).json({ treino });
  } catch (err) {
    next(err);
  }
}

export async function salvarExecucao(req, res, next) {
  try {
    const data = salvarExecucaoSchema.parse(req.body);
    const result = await salvarExecucaoSvc({
      user: req.user,
      treinoId: req.params.id,
      input: data,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function remover(req, res, next) {
  try {
    const result = await deleteTreino({ user: req.user, treinoId: req.params.id });
    res.json(result);
  } catch (err) {
    next(err);
  }
}
