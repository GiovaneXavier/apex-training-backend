import { criarProvaSchema, listProvasQuery } from '../schemas/prova.schemas.js';
import {
  listProvasByAluno,
  criarProva,
  deleteProva,
} from '../services/prova.service.js';

export async function listByAluno(req, res, next) {
  try {
    const filters = listProvasQuery.parse(req.query);
    const provas = await listProvasByAluno({
      user: req.user,
      alunoId: req.params.alunoId,
      filters,
    });
    res.json({ provas });
  } catch (err) {
    next(err);
  }
}

export async function criar(req, res, next) {
  try {
    const data = criarProvaSchema.parse(req.body);
    const prova = await criarProva({ user: req.user, input: data });
    res.status(201).json({ prova });
  } catch (err) {
    next(err);
  }
}

export async function remover(req, res, next) {
  try {
    const result = await deleteProva({ user: req.user, provaId: req.params.id });
    res.json(result);
  } catch (err) {
    next(err);
  }
}
