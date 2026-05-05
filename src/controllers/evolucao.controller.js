import { z } from 'zod';
import {
  evolucaoCreateSchema,
  evolucaoUpdateSchema,
  evolucaoListQuery,
} from '../schemas/evolucao.schemas.js';
import {
  listEvolucoes, getEvolucao,
  createEvolucao, updateEvolucao, deleteEvolucao,
  previewBodyFat,
} from '../services/evolucao.service.js';

export async function list(req, res, next) {
  try {
    const filters = evolucaoListQuery.parse(req.query);
    const items = await listEvolucoes({ user: req.user, filters });
    res.json(items);
  } catch (err) { next(err); }
}

export async function getOne(req, res, next) {
  try {
    const ev = await getEvolucao({ user: req.user, id: req.params.id });
    res.json(ev);
  } catch (err) { next(err); }
}

export async function create(req, res, next) {
  try {
    const input = evolucaoCreateSchema.parse(req.body);
    const ev = await createEvolucao({ user: req.user, input });
    res.status(201).json(ev);
  } catch (err) { next(err); }
}

export async function update(req, res, next) {
  try {
    const input = evolucaoUpdateSchema.parse(req.body);
    const ev = await updateEvolucao({ user: req.user, id: req.params.id, input });
    res.json(ev);
  } catch (err) { next(err); }
}

export async function remove(req, res, next) {
  try {
    const r = await deleteEvolucao({ user: req.user, id: req.params.id });
    res.json(r);
  } catch (err) { next(err); }
}

const previewSchema = evolucaoCreateSchema.pick({
  protocolo: true, medidas: true, sexoBio: true,
  idadeAnos: true, pesoKg: true, alturaCm: true,
});

export async function preview(req, res, next) {
  try {
    const input = previewSchema.parse(req.body);
    const result = await previewBodyFat(input);
    res.json(result);
  } catch (err) { next(err); }
}
