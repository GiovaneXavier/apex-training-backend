import { planoCreateSchema, planoUpdateSchema, planoListQuery } from '../schemas/plano.schemas.js';
import {
  listPlanos,
  getPlanoAtual,
  createPlano,
  updatePlano,
  deletePlano,
} from '../services/plano.service.js';

export async function list(req, res, next) {
  try {
    const filters = planoListQuery.parse(req.query);
    const planos = await listPlanos({ user: req.user, filters });
    res.json({ planos });
  } catch (err) { next(err); }
}

export async function atual(req, res, next) {
  try {
    const plano = await getPlanoAtual({
      user: req.user,
      alunoId: req.params.alunoId,
    });
    res.json({ plano });
  } catch (err) { next(err); }
}

export async function create(req, res, next) {
  try {
    const input = planoCreateSchema.parse(req.body);
    const plano = await createPlano({ user: req.user, input });
    res.status(201).json({ plano });
  } catch (err) { next(err); }
}

export async function update(req, res, next) {
  try {
    const input = planoUpdateSchema.parse(req.body);
    const plano = await updatePlano({ user: req.user, id: req.params.id, input });
    res.json({ plano });
  } catch (err) { next(err); }
}

export async function remove(req, res, next) {
  try {
    const result = await deletePlano({ user: req.user, id: req.params.id });
    res.json(result);
  } catch (err) { next(err); }
}
