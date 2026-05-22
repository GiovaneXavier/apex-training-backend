import { z } from 'zod';

import {
  listAlunosVinculados,
  vincularPorEmail,
  desvincular,
  detalheAluno,
  dashboardProfessor,
  listCalendarioAlunos,
} from '../services/professor.service.js';
import { listAlertasProf } from '../services/coach.service.js';
import { HttpError } from '../middleware/errorHandler.js';

const calendarioQuery = z.object({
  desde: z.string().datetime(),
  ate: z.string().datetime(),
});

const vincularSchema = z.object({
  email: z.string().email('Email inválido').toLowerCase().trim(),
});

function ensureProf(req) {
  if (req.user.role !== 'PROFESSOR') throw new HttpError(403, 'Apenas professores');
}

export async function alunos(req, res, next) {
  try {
    ensureProf(req);
    const list = await listAlunosVinculados(req.user.userId);
    res.json({ alunos: list });
  } catch (err) {
    next(err);
  }
}

export async function vincular(req, res, next) {
  try {
    ensureProf(req);
    const { email } = vincularSchema.parse(req.body);
    await vincularPorEmail(req.user.userId, email);
    // PR #14 — resposta genérica e idempotente (anti-enumeration). O
    // profissional confirma o vínculo refrescando a lista de alunos.
    res.json({
      ok: true,
      message: 'Se o email pertencer a um aluno cadastrado, o vínculo foi criado. Atualize a lista para confirmar.',
    });
  } catch (err) {
    next(err);
  }
}

export async function removerVinculo(req, res, next) {
  try {
    ensureProf(req);
    const result = await desvincular(req.user.userId, req.params.vinculoId);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function alunoDetalhe(req, res, next) {
  try {
    ensureProf(req);
    const data = await detalheAluno(req.user.userId, req.params.alunoId);
    res.json(data);
  } catch (err) {
    next(err);
  }
}

export async function dashboard(req, res, next) {
  try {
    ensureProf(req);
    const stats = await dashboardProfessor(req.user.userId);
    res.json(stats);
  } catch (err) {
    next(err);
  }
}

export async function calendario(req, res, next) {
  try {
    ensureProf(req);
    const { desde, ate } = calendarioQuery.parse(req.query);
    const data = await listCalendarioAlunos(req.user.userId, { desde, ate });
    res.json(data);
  } catch (err) {
    next(err);
  }
}

// PR #17 — alertas de aderência por aluno vinculado.
export async function alertas(req, res, next) {
  try {
    ensureProf(req);
    const alertas = await listAlertasProf({ user: req.user });
    res.json({ alertas });
  } catch (err) {
    next(err);
  }
}
