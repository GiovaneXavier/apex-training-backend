import { z } from 'zod';

import {
  connect,
  disconnect,
  status,
  syncAtividades,
  listAtividades,
} from '../services/strava.service.js';
import { HttpError } from '../middleware/errorHandler.js';

// state: defesa em camadas — frontend valida a igualdade entre URL e
// sessionStorage. Aqui validamos apenas o FORMATO (presença + forma
// base64url + tamanho razoável). Comparação semântica não é possível
// no backend porque o state é client-side (sessionStorage), por design.
// Validar formato impede que requests sem state cheguem no `exchangeCode`.
const connectSchema = z.object({
  code: z.string().min(1, 'Code obrigatório'),
  state: z
    .string()
    .min(16, 'State muito curto')
    .max(128, 'State muito longo')
    .regex(/^[A-Za-z0-9_-]+$/, 'State em formato inválido'),
});

function ensureAluno(req) {
  if (req.user.role !== 'ALUNO') throw new HttpError(403, 'Apenas alunos têm Strava');
}

export async function conectar(req, res, next) {
  try {
    ensureAluno(req);
    // `state` é validado por formato (Zod). O service não usa o valor —
    // a verdade da igualdade fica no client. Mantemos a presença aqui
    // como contrato explícito: qualquer cliente que chame /strava/connect
    // SEM state recebe 400 antes de tocar o Strava API.
    const { code } = connectSchema.parse(req.body);
    const result = await connect(req.user.userId, code);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function desconectar(req, res, next) {
  try {
    ensureAluno(req);
    const result = await disconnect(req.user.userId);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function obterStatus(req, res, next) {
  try {
    ensureAluno(req);
    const data = await status(req.user.userId);
    res.json(data);
  } catch (err) {
    next(err);
  }
}

export async function sincronizar(req, res, next) {
  try {
    ensureAluno(req);
    const result = await syncAtividades(req.user.userId);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

export async function atividades(req, res, next) {
  try {
    const limit = req.query.limit ? Number(req.query.limit) : 50;
    const data = await listAtividades({
      user: req.user,
      alunoId: req.params.alunoId,
      limit,
    });
    res.json({ atividades: data });
  } catch (err) {
    next(err);
  }
}
