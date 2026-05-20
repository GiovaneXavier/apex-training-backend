import { prisma } from '../lib/prisma.js';
import { resolveAlunoAccess } from '../lib/access.js';
import { HttpError } from '../middleware/errorHandler.js';
import {
  exchangeCode,
  refreshAccessToken,
  fetchActivities,
  fetchActivity,
} from '../lib/strava.js';
import { encrypt, decrypt } from '../lib/crypto.js';

// Tokens Strava persistidos em AES-256-GCM via lib/crypto.
// Regra: cifrar antes de gravar; decifrar imediatamente antes de usar.
// Nunca retornar o token cifrado nem o plaintext para fora deste módulo
// (exceto via fluxo OAuth — o token só viaja serviço → strava.com).

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
  if (expiresAt > now + 60_000) return decrypt(aluno.stravaToken);

  if (!aluno.stravaRefresh) throw new HttpError(401, 'Refresh token ausente — reconectar');

  // refreshAccessToken HTTP exige plaintext — decifra só pra mandar pro Strava.
  const refreshTokenPlain = decrypt(aluno.stravaRefresh);
  const refreshed = await refreshAccessToken(refreshTokenPlain);

  // Strava pode rotacionar refresh_token; preserva o anterior se não veio.
  const nextRefreshPlain = refreshed.refresh_token ?? refreshTokenPlain;

  await prisma.aluno.update({
    where: { id: aluno.id },
    data: {
      stravaToken: encrypt(refreshed.access_token),
      stravaRefresh: encrypt(nextRefreshPlain),
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
      stravaToken: encrypt(data.access_token),
      stravaRefresh: encrypt(data.refresh_token),
      stravaExpiresAt: new Date(data.expires_at * 1000),
      stravaUserId: data.athlete?.id ? String(data.athlete.id) : null,
    },
  });
  return {
    connected: true,
    stravaUserId: updated.stravaUserId,
    expiraEm: updated.stravaExpiresAt,
    // NUNCA retornar token cifrado nem plaintext para o cliente.
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
  // `connected` é booleano derivado — nunca expõe o token em si.
  return {
    connected: !!aluno.stravaToken,
    stravaUserId: aluno.stravaUserId,
    expiraEm: aluno.stravaExpiresAt,
  };
}

export async function syncAtividades(userId) {
  const aluno = await getAluno(userId);
  const token = await ensureValidToken(aluno); // já vem plaintext

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

// ─── PR #41a — Webhook event processing ─────────────────────────────
//
// Strava manda eventos via POST com payload:
//   { object_type, aspect_type, object_id, owner_id, event_time, updates }
//
// object_type:  'activity' | 'athlete'
// aspect_type:  'create' | 'update' | 'delete'
// object_id:    ID da atividade (ou athlete)
// owner_id:     stravaUserId do atleta dono
// event_time:   unix timestamp
// updates:      mudanças específicas (para aspect_type=update)
//
// Strava NÃO assina os POST events — single mitigation é validar que
// `owner_id` mapeia pra um Aluno conectado. Eventos com owner desconhecido
// são silenciosamente descartados (Strava não retenta se respondemos 200).
//
// Idempotência: dedup por `stravaId` no upsert. Mesmo evento 2x = no-op.
//
// IMPORTANTE: Strava exige resposta em < 2s, senão retry. Operação deve
// ser rápida — fetch + upsert local. Sem heurística de matching aqui
// (vem no PR #41b). Logging pra observabilidade.

export async function processWebhookEvent(payload) {
  // Só lidamos com eventos de atividade. Eventos de athlete (ex: atleta
  // revogou autorização) são informativos — podemos tratar no PR #41b+
  // pra limpar tokens orfãos. Por enquanto, ack silencioso.
  if (payload?.object_type !== 'activity') {
    return { ignored: true, reason: 'not-activity' };
  }

  const ownerId = payload.owner_id ? String(payload.owner_id) : null;
  if (!ownerId) {
    return { ignored: true, reason: 'no-owner' };
  }

  // Aluno desconhecido = atleta nunca conectou conosco. Strava manda
  // eventos pra TODA aplicação que tem subscription, então isso é normal
  // (não erro). Apenas ignora.
  const aluno = await prisma.aluno.findFirst({ where: { stravaUserId: ownerId } });
  if (!aluno) {
    return { ignored: true, reason: 'unknown-owner', ownerId };
  }

  const stravaActivityId = payload.object_id ? String(payload.object_id) : null;
  if (!stravaActivityId) {
    return { ignored: true, reason: 'no-activity-id' };
  }

  // Aspect handling.
  if (payload.aspect_type === 'delete') {
    // Strava deletou (ou ocultou) atividade. Refletimos local.
    // deleteMany pra não estourar se já tiver sido removida.
    const result = await prisma.atividadeStrava.deleteMany({
      where: { stravaId: stravaActivityId, alunoId: aluno.id },
    });
    return { processed: true, action: 'deleted', removed: result.count };
  }

  // create | update — fetch detalhe + upsert.
  const token = await ensureValidToken(aluno);
  const activity = await fetchActivity(token, stravaActivityId);
  if (!activity) {
    // Atividade deletada entre o evento e nosso fetch. Trate como delete.
    await prisma.atividadeStrava.deleteMany({
      where: { stravaId: stravaActivityId, alunoId: aluno.id },
    });
    return { processed: true, action: 'race-deleted' };
  }

  // Upsert por stravaId — idempotente por construção.
  const data = {
    tipo: activity.type ?? 'Outro',
    nome: activity.name ?? 'Atividade',
    distanciaM: activity.distance ?? 0,
    duracaoSeg: activity.moving_time ?? 0,
    ritmoMedio: typeof activity.average_speed === 'number' ? activity.average_speed : null,
    fcMedia: activity.average_heartrate ? Math.round(activity.average_heartrate) : null,
    iniciadoEm: new Date(activity.start_date),
    payloadRaw: activity,
    sincronizadoEm: new Date(),
  };
  await prisma.atividadeStrava.upsert({
    where: { stravaId: stravaActivityId },
    create: { alunoId: aluno.id, stravaId: stravaActivityId, ...data },
    update: data,
  });

  // PR #41b vai pluggar aqui o matching contra treinos. Hoje apenas persiste.
  return {
    processed: true,
    action: payload.aspect_type === 'create' ? 'created' : 'updated',
    stravaActivityId,
    alunoId: aluno.id,
  };
}
