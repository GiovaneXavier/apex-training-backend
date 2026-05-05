import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

import { prisma } from '../lib/prisma.js';
import { HttpError } from '../middleware/errorHandler.js';

const SALT_ROUNDS = 10;

export async function registerUser(input) {
  const existing = await prisma.user.findUnique({ where: { email: input.email } });
  if (existing) throw new HttpError(409, 'Email já cadastrado');

  const senhaHash = await bcrypt.hash(input.senha, SALT_ROUNDS);

  // Cria User + perfil específico em transação
  const user = await prisma.$transaction(async (tx) => {
    const u = await tx.user.create({
      data: {
        email: input.email,
        senhaHash,
        nome: input.nome,
        role: input.role,
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

  return buildAuthResponse(user);
}

export async function loginUser({ email, senha }) {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) throw new HttpError(401, 'Credenciais inválidas');

  const ok = await bcrypt.compare(senha, user.senhaHash);
  if (!ok) throw new HttpError(401, 'Credenciais inválidas');

  return buildAuthResponse(user);
}

export async function getMe(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      aluno: true,
      professor: true,
      nutricionista: true,
    },
  });
  if (!user) throw new HttpError(404, 'Usuário não encontrado');
  return sanitizeUser(user);
}

function buildAuthResponse(user) {
  const token = jwt.sign(
    { sub: user.id, userId: user.id, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' },
  );
  return { token, user: sanitizeUser(user) };
}

function sanitizeUser(user) {
  const { senhaHash: _ignored, ...rest } = user;
  return rest;
}
