import { z } from 'zod';

export const Role = z.enum(['ALUNO', 'PROFESSOR', 'NUTRICIONISTA']);

export const registerSchema = z.object({
  email: z.string().email('Email inválido').toLowerCase().trim(),
  senha: z.string().min(8, 'Mínimo 8 caracteres'),
  nome: z.string().min(2, 'Nome muito curto').max(120).trim(),
  role: Role,
  // Campos opcionais por role
  crn: z.string().trim().optional(),         // Nutricionista
  bio: z.string().max(500).trim().optional() // Professor
});

export const loginSchema = z.object({
  email: z.string().email('Email inválido').toLowerCase().trim(),
  senha: z.string().min(1, 'Senha obrigatória'),
});
