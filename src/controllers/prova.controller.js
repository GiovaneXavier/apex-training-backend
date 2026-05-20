import {
  criarProvaSchema,
  atualizarProvaSchema,
  promoverProvaSchema,
  listProvasQuery,
} from '../schemas/prova.schemas.js';
import {
  listProvasByAluno,
  getProvaAlvo,
  criarProva,
  atualizarProva,
  promoverProva,
  arquivarProva,
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

// PR #37 — endpoint dedicado pro Dashboard: retorna a Race A ativa.
export async function alvoByAluno(req, res, next) {
  try {
    const alvo = await getProvaAlvo({ user: req.user, alunoId: req.params.alunoId });
    res.json({ alvo });
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

export async function atualizar(req, res, next) {
  try {
    const patch = atualizarProvaSchema.parse(req.body);
    const prova = await atualizarProva({ user: req.user, provaId: req.params.id, patch });
    res.json({ prova });
  } catch (err) {
    next(err);
  }
}

export async function promover(req, res, next) {
  try {
    const { prioridade } = promoverProvaSchema.parse(req.body);
    const prova = await promoverProva({ user: req.user, provaId: req.params.id, prioridade });
    res.json({ prova });
  } catch (err) {
    next(err);
  }
}

export async function arquivar(req, res, next) {
  try {
    const prova = await arquivarProva({ user: req.user, provaId: req.params.id });
    res.json({ prova });
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
