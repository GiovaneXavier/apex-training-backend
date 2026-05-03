# Apex Training — Backend

API do sistema multi-sports de prescrição e execução de treinos. Stack PERN: **Node.js + Express + Prisma + PostgreSQL**.

## Perfis

- **Aluno** — recebe prescrições, executa treinos, registra RPs, sincroniza Strava.
- **Professor** — gerencia alunos, prescreve treinos baseados em % de RP, acompanha calendário.
- **Nutricionista** — leitura mediante aceite do aluno; vê rotina de treinos e provas.

## Recursos-chave

- Modelagem **multi-sports** via campo `detalhes` JSON em `Treino` e `Prova` (corrida, musculação, natação, triathlon convivem na mesma tabela).
- Log de execução separado da prescrição (`prescrito` vs `realizado`).
- Detecção automática de **Recordes Pessoais (RPs)** ao salvar treino — retorna flag `novoRecorde`.
- Integração **Strava** via OAuth 2.0 (sync manual).
- JWT para autenticação.

## Rotas principais

```
POST  /api/auth/login
POST  /api/auth/register
GET   /api/treinos/:alunoId
POST  /api/treinos/:id/salvar      → { novoRecorde: boolean }
POST  /api/treinos/prescrever
POST  /api/strava/sync
GET   /api/rps/:alunoId
```

## Setup

```bash
npm install
cp .env.example .env
npx prisma migrate dev
npm run dev
```

## Branches

- `main` — produção
- `dev` — integração
- `feature/sX-nome` — sprints
