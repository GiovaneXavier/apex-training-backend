import {
  exercicioCreateSchema,
  exercicioUpdateSchema,
  exercicioListQuery,
} from '../schemas/exercicio.schemas.js';
import {
  listExercicios,
  getExercicio,
  createExercicio,
  updateExercicio,
  deleteExercicio,
} from '../services/exercicio.service.js';

export async function list(req, res, next) {
  try {
    const query = exercicioListQuery.parse(req.query);
    const items = await listExercicios(query);
    res.json(items);
  } catch (err) { next(err); }
}

export async function getOne(req, res, next) {
  try {
    const item = await getExercicio(req.params.id);
    res.json(item);
  } catch (err) { next(err); }
}

export async function create(req, res, next) {
  try {
    const data = exercicioCreateSchema.parse(req.body);
    const item = await createExercicio(req.user.userId, data);
    res.status(201).json(item);
  } catch (err) { next(err); }
}

export async function update(req, res, next) {
  try {
    const data = exercicioUpdateSchema.parse(req.body);
    const item = await updateExercicio(req.user.userId, req.params.id, data);
    res.json(item);
  } catch (err) { next(err); }
}

export async function remove(req, res, next) {
  try {
    const r = await deleteExercicio(req.user.userId, req.params.id);
    res.json(r);
  } catch (err) { next(err); }
}
