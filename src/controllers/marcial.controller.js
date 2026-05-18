import { promocaoCreateSchema, promocaoListQuery } from '../schemas/marcial.schemas.js';
import {
  getFaixaAtual,
  getJornadaMarcial,
  listPromocoes,
  registrarPromocao,
  deletePromocao,
} from '../services/marcial.service.js';

// PR #24 — endpoints da Jornada Marcial.

export async function faixaAtual(req, res, next) {
  try {
    const faixa = await getFaixaAtual({
      user: req.user, alunoId: req.params.alunoId,
    });
    res.json({ faixa });
  } catch (err) { next(err); }
}

export async function jornada(req, res, next) {
  try {
    const data = await getJornadaMarcial({
      user: req.user, alunoId: req.params.alunoId,
    });
    res.json(data);
  } catch (err) { next(err); }
}

export async function list(req, res, next) {
  try {
    const filters = promocaoListQuery.parse(req.query);
    const promocoes = await listPromocoes({ user: req.user, filters });
    res.json({ promocoes });
  } catch (err) { next(err); }
}

export async function create(req, res, next) {
  try {
    const input = promocaoCreateSchema.parse(req.body);
    const promocao = await registrarPromocao({ user: req.user, input });
    res.status(201).json({ promocao });
  } catch (err) { next(err); }
}

export async function remove(req, res, next) {
  try {
    const result = await deletePromocao({ user: req.user, id: req.params.id });
    res.json(result);
  } catch (err) { next(err); }
}
