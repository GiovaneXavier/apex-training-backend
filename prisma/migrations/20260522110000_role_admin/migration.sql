-- PR #32.5 — Adiciona ADMIN ao enum Role.
-- God-mode operacional (QA/E2E/debug). Bypass total na ACL via access.js.
-- Inserido APENAS via `npm run seed:admin` ou injeção manual no DB —
-- NUNCA via fluxo de cadastro normal.

ALTER TYPE "Role" ADD VALUE 'ADMIN';
