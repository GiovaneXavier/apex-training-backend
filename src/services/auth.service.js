import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

import { prisma } from '../lib/prisma.js';
import { env } from '../lib/env.js';
import { HttpError } from '../middleware/errorHandler.js';

// SALT_ROUNDS = 12: OWASP 2024+. Antes era 10 — leve, mas vulnerável a
// hashing em GPU em larga escala. Custo: +5x CPU por login (sub-100ms).
const SALT_ROUNDS = 12;

// Roles que entram pendentes de aprovação. Aluno entra ativo direto.
// Sem fluxo admin nesta sprint — aprovação é manual via psql ou
// future-admin-panel. Documentado no comentário do User.ativo no schema.
const ROLES_PRECISAM_APROVACAO = new Set(['PROFESSOR', 'NUTRICIONISTA']);

function newCsrfToken() {
  return randomBytes(24).toString('base64url');
}

function signJwt(user, csrf) {
  return jwt.sign(
    { sub: user.id, userId: user.id, role: user.role, csrf },
    env.JWT_SECRET,
    { expiresIn: env.JWT_EXPIRES_IN },
  );
}

export async function registerUser(input) {
  const existing = await prisma.user.findUnique({ where: { email: input.email } });
  if (existing) throw new HttpError(409, 'Email já cadastrado');

  const senhaHash = await bcrypt.hash(input.senha, SALT_ROUNDS);
  const precisaAprovacao = ROLES_PRECISAM_APROVACAO.has(input.role);

  const user = await prisma.$transaction(async (tx) => {
    const u = await tx.user.create({
      data: {
        email: input.email,
        senhaHash,
        nome: input.nome,
        role: input.role,
        // Só passa `ativo` quando precisa marcar inativo. ALUNO usa o
        // default(true) do schema — então o registro de aluno funciona
        // mesmo pré-migration do PR #2 (transitional safety).
        ...(precisaAprovacao ? { ativo: false } : {}),
      },
    });
    if (input.role === 'ALUNO') {
      await tx.aluno.create({ data: { userId: u.id } });
    } else if (input.role === 'PROFESSOR') {
      await tx.professor.create({ data: { userId: u.id, bio: input.bio || null } });
    } else if (input.role === 'NUTRICIONISTA') {
      await tx.nutricionista.create({ data: { userId: u.id, crn: input.crn || null } });
    }
    return u;
  });

  // Profissional pendente: não emite token. UX no frontend mostra mensagem.
  if (precisaAprovacao) {
    return {
      pending: true,
      message: 'Cadastro recebido. Sua conta profissional aguarda aprovação manual.',
    };
  }
  return buildAuthResponse(user);
}

export async function loginUser({ email, senha }) {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) throw new HttpError(401, 'Credenciais inválidas');

  const ok = await bcrypt.compare(senha, user.senhaHash);
  if (!ok) throw new HttpError(401, 'Credenciais inválidas');

  // Usar `=== false` (não `!user.ativo`) para tolerar instâncias rodando
  // contra DB pré-PR #2 onde a coluna ainda não existe — undefined não
  // deve bloquear usuários legados. Após a migration, todos default true.
  if (user.ativo === false) {
    throw new HttpError(403, 'Conta inativa ou aguardando aprovação');
  }

  return buildAuthResponse(user);
}

export async function getMe(userId, csrfFromJwt) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      // DTO estrito: NUNCA expõe stravaToken / stravaRefresh — mesmo cifrados.
      // Cliente precisa apenas saber SE está conectado e quando expira.
      aluno: {
        select: {
          id: true,
          dataNascimento: true,
          pesoKg: true,
          alturaCm: true,
          stravaUserId: true,
          stravaExpiresAt: true,
        },
      },
      professor: { select: { id: true, bio: true } },
      nutricionista: { select: { id: true, crn: true } },
    },
  });
  if (!user) throw new HttpError(404, 'Usuário não encontrado');
  if (user.ativo === false) throw new HttpError(403, 'Conta inativa');

  const sanitized = sanitizeUser(user);
  if (sanitized.aluno) {
    // Boolean derivado — substitui qualquer pista do token.
    sanitized.aluno = {
      ...sanitized.aluno,
      stravaConnected: !!sanitized.aluno.stravaUserId,
    };
  }

  // Devolve o csrf pra frontend reidratar em memória após reload do PWA.
  // (JWT está no cookie HttpOnly e não é legível por JS — daí precisamos
  // ecoar o csrf por um canal que o JS consiga ler.)
  return { user: sanitized, csrf: csrfFromJwt };
}

export function buildAuthResponse(user) {
  const csrf = newCsrfToken();
  return {
    token: signJwt(user, csrf),
    csrf,
    user: sanitizeUser(user),
  };
}

function sanitizeUser(user) {
  const { senhaHash: _ignored, ...rest } = user;
  return rest;
}
