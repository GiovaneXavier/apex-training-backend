import {
  rotinaCreateSchema,
  rotinaUpdateSchema,
  rotinaListQuery,
  reagendarTreinoSchema,
  iniciarTreinoSchema,
} from '../schemas/rotina.schemas.js';
import {
  listRotinas,
  getRotina,
  createRotina,
  updateRotina,
  deleteRotina,
  rotinasDoDia,
  iniciarTreinoDeRotina,
  reagendarTreino,
} from '../services/rotina.service.js';

// Controllers agora propagam req.user para o service em TODA rota.
// Service usa resolveAlunoAccess pra autorizar. Não há mais bypass
// de ACL via "endpoint só de leitura".

export async function list(req, res, next) {
  try {
    const query = rotinaListQuery.parse(req.query);
    const items = await listRotinas({ user: req.user, ...query });
    res.json(items);
  } catch (err) { next(err); }
}

export async function getOne(req, res, next) {
  try {
    const r = await getRotina({ user: req.user, id: req.params.id });
    res.json(r);
  } catch (err) { next(err); }
}

export async function create(req, res, next) {
  try {
    const data = rotinaCreateSchema.parse(req.body);
    const r = await createRotina(req.user.userId, data);
    res.status(201).json(r);
  } catch (err) { next(err); }
}

export async function update(req, res, next) {
  try {
    const data = rotinaUpdateSchema.parse(req.body);
    const r = await updateRotina(req.user.userId, req.params.id, data);
    res.json(r);
  } catch (err) { next(err); }
}

export async function remove(req, res, next) {
  try {
    const r = await deleteRotina(req.user.userId, req.params.id);
    res.json(r);
  } catch (err) { next(err); }
}

export async function doDia(req, res, next) {
  try {
    const dataRef = req.query.data ? new Date(req.query.data) : new Date();
    const items = await rotinasDoDia({
      user: req.user,
      alunoId: req.params.alunoId,
      dataRef,
    });
    res.json(items);
  } catch (err) { next(err); }
}

export async function iniciar(req, res, next) {
  try {
    const { dataAlvo } = iniciarTreinoSchema.parse(req.body ?? {});
    const treino = await iniciarTreinoDeRotina(req.user.userId, req.params.id, dataAlvo);
    res.status(201).json(treino);
  } catch (err) { next(err); }
}

export async function reagendar(req, res, next) {
  try {
    const { novaDataAlvo } = reagendarTreinoSchema.parse(req.body);
    const t = await reagendarTreino(req.user.userId, req.params.id, novaDataAlvo);
    res.json(t);
  } catch (err) { next(err); }
}
