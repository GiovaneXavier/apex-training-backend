import { prisma } from '../lib/prisma.js';
import { resolveAlunoAccess } from '../lib/access.js';
import { HttpError } from '../middleware/errorHandler.js';
import { exchangeCode, refreshAccessToken, fetchActivities } from '../lib/strava.js';

async function getAluno(userId) {
  const a = await prisma.aluno.findUnique({ where: { userId } });
  if (!a) throw new HttpError(404, 'Perfil de aluno não encontrado');
  return a;
}

async function ensureValidToken(aluno) {
  if (!aluno.stravaToken) throw new HttpError(400, 'Strava não conectado');
  const now = Date.now();
  const expiresAt = aluno.stravaExpiresAt ? new Date(aluno.stravaExpiresAt).getTime() : 0;
  // Refresh com 60s de folga
  if (expiresAt > now + 60_000) return aluno.stravaToken;
  if (!aluno.stravaRefresh) throw new HttpError(401, 'Refresh token ausente — reconectar');

  const refreshed = await refreshAccessToken(aluno.stravaRefresh);
  await prisma.aluno.update({
    where: { id: aluno.id },
    data: {
      stravaToken: refreshed.access_token,
      stravaRefresh: refreshed.refresh_token ?? aluno.stravaRefresh,
      stravaExpiresAt: new Date(refreshed.expires_at * 1000),
    },
  });
  return refreshed.access_token;
}

export async function connect(userId, code) {
  const aluno = await getAluno(userId);
  const data = await exchangeCode(code);
  const updated = await prisma.aluno.update({
    where: { id: aluno.id },
    data: {
      stravaToken: data.access_token,
      stravaRefresh: data.refresh_token,
      stravaExpiresAt: new Date(data.expires_at * 1000),
      stravaUserId: data.athlete?.id ? String(data.athlete.id) : null,
    },
  });
  return {
    connected: true,
    stravaUserId: updated.stravaUserId,
    expiraEm: updated.stravaExpiresAt,
  };
}

export async function disconnect(userId) {
  const aluno = await getAluno(userId);
  await prisma.aluno.update({
    where: { id: aluno.id },
    data: {
      stravaToken: null,
      stravaRefresh: null,
      stravaExpiresAt: null,
      stravaUserId: null,
    },
  });
  return { ok: true };
}

export async function status(userId) {
  const aluno = await getAluno(userId);
  return {
    connected: !!aluno.stravaToken,
    stravaUserId: aluno.stravaUserId,
    expiraEm: aluno.stravaExpiresAt,
  };
}

export async function syncAtividades(userId) {
  const aluno = await getAluno(userId);
  const token = await ensureValidToken(aluno);

  // Pega após a última sincronizada (ou últimos 90 dias se nunca sync)
  const ultima = await prisma.atividadeStrava.findFirst({
    where: { alunoId: aluno.id },
    orderBy: { iniciadoEm: 'desc' },
  });
  const after = ultima
    ? ultima.iniciadoEm.getTime()
    : Date.now() - 90 * 24 * 60 * 60 * 1000;

  const list = await fetchActivities(token, { after, perPage: 50, page: 1 });
  if (!Array.isArray(list)) {
    throw new HttpError(502, 'Resposta inesperada do Strava');
  }

  let novas = 0;
  for (const a of list) {
    const stravaId = String(a.id);
    const existing = await prisma.atividadeStrava.findUnique({ where: { stravaId } });
    if (existing) continue;
    await prisma.atividadeStrava.create({
      data: {
        alunoId: aluno.id,
        stravaId,
        tipo: a.type ?? 'Outro',
        nome: a.name ?? 'Atividade',
        distanciaM: a.distance ?? 0,
        duracaoSeg: a.moving_time ?? 0,
        ritmoMedio: typeof a.average_speed === 'number' ? a.average_speed : null,
        fcMedia: a.average_heartrate ? Math.round(a.average_heartrate) : null,
        iniciadoEm: new Date(a.start_date),
        payloadRaw: a,
      },
    });
    novas++;
  }
  return { novas, total: list.length, sincronizadoEm: new Date().toISOString() };
}

export async function listAtividades({ user, alunoId, limit = 50 }) {
  const aluno = await resolveAlunoAccess({ user, alunoId });
  return prisma.atividadeStrava.findMany({
    where: { alunoId: aluno.id },
    orderBy: { iniciadoEm: 'desc' },
    take: Math.min(Math.max(limit, 1), 200),
  });
}
