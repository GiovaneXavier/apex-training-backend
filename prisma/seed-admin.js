// PR #32.5 — Seeder Admin Master.
//
// Cria (ou re-ativa) um único usuário ADMIN no banco. God-mode operacional
// pra QA/E2E/debug navegar livre por endpoints.
//
// USO:
//   npm run seed:admin
//
// Variáveis (todas opcionais, com defaults seguros pra dev):
//   ADMIN_EMAIL    — default "admin@apex.local"
//   ADMIN_PASSWORD — default "admin-change-me-32-chars-minimum-pls"
//   ADMIN_NOME     — default "Admin Apex"
//
// SEGURANÇA:
//   - Falha imediato em NODE_ENV=production sem ADMIN_PASSWORD setada
//     EXPLICITAMENTE (não vamos criar admin com senha placeholder em prod).
//   - Hash bcrypt rounds=12 (mesmo padrão do auth.service).
//   - Idempotente: se admin com mesmo email existe, atualiza role/ativo
//     mas NÃO sobrescreve senha (operador precisa apagar manualmente
//     pra rotacionar).
//
// REMOÇÃO:
//   Apagar admin = deletar a row no DB diretamente (ou via prisma studio).
//   Não há comando de remoção pra evitar acidente em prod.

import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@apex.local';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin-change-me-32-chars-minimum-pls';
const ADMIN_NOME = process.env.ADMIN_NOME || 'Admin Apex';

async function main() {
  // Fail-fast em prod sem senha explícita — evita criar admin com
  // password placeholder por engano em ambiente real.
  if (process.env.NODE_ENV === 'production' && !process.env.ADMIN_PASSWORD) {
    console.error('[seed:admin] ERRO: NODE_ENV=production exige ADMIN_PASSWORD explícita.');
    process.exit(1);
  }

  const existing = await prisma.user.findUnique({ where: { email: ADMIN_EMAIL } });

  if (existing) {
    // Idempotente — atualiza role + ativo, mas mantém senha existente.
    const updated = await prisma.user.update({
      where: { email: ADMIN_EMAIL },
      data: { role: 'ADMIN', ativo: true, nome: ADMIN_NOME },
      select: { id: true, email: true, role: true, ativo: true },
    });
    console.log('[seed:admin] Admin existente atualizado:', updated);
    console.log('[seed:admin] Senha PRESERVADA. Apague o usuário manualmente pra rotacionar.');
    return;
  }

  const senhaHash = await bcrypt.hash(ADMIN_PASSWORD, 12);
  const novo = await prisma.user.create({
    data: {
      email: ADMIN_EMAIL,
      senhaHash,
      nome: ADMIN_NOME,
      role: 'ADMIN',
      ativo: true,
    },
    select: { id: true, email: true, role: true, ativo: true },
  });

  console.log('[seed:admin] Admin criado:', novo);
  console.log(`[seed:admin] Email:    ${ADMIN_EMAIL}`);
  console.log('[seed:admin] Senha:    (oculta — use a env ADMIN_PASSWORD ou o default conhecido em dev)');
  console.log('[seed:admin] Login normal via POST /api/auth/login. Token JWT carrega role=ADMIN.');
}

main()
  .catch((err) => {
    console.error('[seed:admin] FAIL:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
