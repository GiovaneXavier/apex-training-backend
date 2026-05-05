import { listRPsByAluno, listRPsQuery } from '../services/rps.service.js';

export async function list(req, res, next) {
  try {
    const filters = listRPsQuery.parse(req.query);
    const data = await listRPsByAluno({
      user: req.user,
      alunoId: req.params.alunoId,
      filters,
    });
    res.json(data);
  } catch (err) {
    next(err);
  }
}
