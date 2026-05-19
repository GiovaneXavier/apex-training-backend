# Apex Training — Status do Projeto

**Data:** 2026-05-19
**Branches:** `dev` (working), `main`, `feat/sentry-observabilidade` (PR #34) em andamento — Sprint 13 em curso
**Repos:** `apex-training-backend` · `apex-training-frontend`

## Sprint 13 — Production Hardening 🛡️

| PR | Tema | Status |
|----|------|--------|
| #32.5 | Admin Master (God-mode operacional pra QA/E2E) | ✅ Implementado |
| #33 | Lazy intra-Progresso (Recharts isolado + SVG donut + GraficoVolume lazy) | ✅ Mergeado |
| #34 | Sentry (frontend + backend) + rastreamento ERR_NETWORK | ✅ Implementado |
| #35 | Playwright E2E (happy paths usando Admin Master) | ⏳ Próximo |
| #36 | VAPID hash check + AbortController em fetches | ⏳ Fechamento |

**PR #34 — entregue (Sentry observabilidade):**
- Backend: `src/lib/sentry.js` — wrapper com `initSentry()` no-op quando DSN ausente OU `NODE_ENV=test`. Auto-instrumentação HTTP/Express. `tracesSampleRate` default 0.1 (proteção de quota). **beforeSend filtra HttpError 4xx** (rejeição esperada do app — não polui dashboard).
- Backend env (`SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `SENTRY_TRACES_SAMPLE_RATE`, `SENTRY_RELEASE`). Derivado `env.sentryEnabled = boolean(DSN) && NODE_ENV !== 'test'`.
- Backend: `errorHandler` chama `captureUnexpectedError` em (1) HttpError ≥500 e (2) erros genéricos não-HttpError (TypeError, etc). ZodError e HttpError 4xx ficam fora.
- Backend: init é EAGER em `src/index.js` (antes de qualquer require) — SDK precisa enganchar `http`/`express` auto-instrument.
- Frontend: `src/lib/sentry.ts` — wrapper com `initSentryFrontend()` no-op sem `VITE_SENTRY_DSN`. **BrowserTracing integration** + **`tracePropagationTargets`** apontando pra `localhost` + origem do `VITE_API_URL` (sem propagação cross-origin pra Anthropic/S3/Strava).
- Frontend: **`beforeSend` filtro de ruído** descarta erros vindos de `chrome-extension://`, `moz-extension://`, `safari-extension://` e `ResizeObserver loop limit exceeded` (warning benigno).
- Frontend: **`captureNetworkError()`** enriquece com `navigator.onLine`, URL, método e código (`ERR_NETWORK`, `ECONNABORTED`). Tags Sentry permitem filtrar "túnel do metrô" vs "backend caiu".
- Frontend: axios interceptor (`src/lib/api.ts`) chama `captureNetworkError` SOMENTE quando `!err.response` (falha de transporte). Erros HTTP 4xx/5xx têm response → tratados pelo Sentry backend.
- Testes: Backend **442** (era 435, +7 — gating no-op em test, filtro 4xx, captura 5xx). Frontend **214** (era 201, +13 — 9 do filtro de ruído + 4 do interceptor axios).
- Bundle: Index principal **86.02 KB Gzip** (era 85.97 → +50 bytes do Sentry/React import em modo no-op). Sem chunks novos significativos.

**Operacional:**
- Backend: setar `SENTRY_DSN` em prod (Render env). Opcional `SENTRY_TRACES_SAMPLE_RATE=0.05` se traffic alto pra cortar custo.
- Frontend: setar `VITE_SENTRY_DSN` no build de prod (Vercel env). CI pode injetar `VITE_SENTRY_RELEASE=$COMMIT_SHA` pra correlacionar deploys.
- Em dev sem DSN: app sobe normal, init no-op, zero overhead.

---

**PR #32.5 — entregue (Admin Master):**
- `Role` enum: adicionado `ADMIN`. Migration `20260522110000_role_admin`.
- `src/lib/access.js`: bypass total em `resolveAlunoAccess` quando role=ADMIN. ADMIN sem `alunoId` → 400 (precisa apontar). ADMIN com alunoId inexistente → 404 (não inventa).
- `src/middleware/auth.middleware.js`: `requireRole` bypassa pra ADMIN — passa em qualquer `requireRole('PROFESSOR')` ou `requireRole('NUTRICIONISTA')` etc.
- **Escopo limitado por design**: ADMIN é god-mode de LEITURA. Services de escrita mantém `user.role !== 'PROFESSOR'` hard-coded — ADMIN não tem perfil profissional vinculado, então nem se bypassasse conseguiria criar Treino/Plano (faltaria FK). Cobre 100% do propósito (navegar/QA/debug) sem furo de segurança.
- `prisma/seed-admin.js` + `npm run seed:admin`: idempotente (re-rodar atualiza role+ativo mas preserva senha). Fail-fast em prod sem `ADMIN_PASSWORD` explícita.
- Testes: **+10** (10/10 verde). Total backend **435**.

**PR #33 — entregue (Lazy intra-Progresso):**
- Estrutura nova: `src/pages/aluno/progresso/{shared,SecaoDesempenho,SecaoEvolucao}.tsx`. Casca `Progresso.tsx` reduzida de 588 linhas → 50 linhas com 2 `React.lazy()`.
- **SVG donut puro** substitui PieChart de Recharts no CardCiclo (geometria trivial — 1 arco com `stroke-dasharray`/`stroke-dashoffset`). Animação 400ms via CSS transition. Custo: zero bytes de lib.
- **`GraficoVolume` lazy import** dentro de SecaoDesempenho — chunk próprio com Suspense fallback ("Carregando matriz de volume…").
- Resultado: Recharts vive APENAS em SecaoEvolucao (LineChart) e GraficoVolume (BarChart) — chunks lazy independentes. Atleta abre tab Desempenho default → vê tudo sem baixar Recharts. Click em Evolução → baixa LineChart chunk sob demanda.
- Substituição completa de Recharts por lib leve **fica pra Sprint 14+ em migração gradual** (gráfico-a-gráfico, sem big-bang).

### Métricas Bundle — PR #33 ⚡

| Chunk | Antes | Depois | Δ |
|-------|-------|--------|---|
| **Progresso (first paint default)** | **129 KB Gzip** monolítico | **~17 KB Gzip** (casca 6.29 + Desempenho 2.48 + GraficoVolume lazy 7.78) | **−87%** |
| SecaoEvolucao (sob demanda) | — | 13.80 KB Gzip | só quando clicado |
| shared chunk (Recharts global) | 103 KB Gzip | 0.67 KB Gzip | Recharts decomposto |
| Index principal | 85.95 KB Gzip | **85.97 KB Gzip** | +2 bytes (negligível) |

Frontend testes: **201/201** (zero regressão).

---

## Sprint 12 — Aluno Intelligence Layer 🔍

| PR | Tema | Status |
|----|------|--------|
| #32 | Weekly Check-in (IA narrativa retroativa com coleira curta) | ✅ Implementado |

**PR #32 — entregue:**
- Prisma: model `AlunoInsightSemanal` (1 ativo por aluno, JSONB result+meta, TTL 7d via `expiresAt`). Migration `20260522100000_aluno_insight_semanal`.
- Backend: `src/lib/insightVeto.js` — **guardião lexical** com 3 categorias (PRESCRITIVO/MEDICO/PREDITIVO), 30+ termos curados. Filtro substring case-insensitive — V1 estrito, **falso positivo em negações documentado em código + teste explícito** ("não houve lesão" também veta; cai no fallback estático → UX continua ok). Evolução futura prevista: classificador semântico.
- Backend: `src/services/alunoInsightData.service.js` — snapshot **determinístico** de 4 semanas. Reusa `computeStreak` (PR #31), recordes, conquistas, timeline (PR #17). Privacy: zero PII no payload (nem nome — narrativa é em 2ª pessoa).
- Backend: `src/services/alunoInsight.service.js` — **triple-guard pipeline**:
  1. `temDadosSuficientes=false` → atalho estático sem tocar LLM.
  2. Cache hit válido → serve.
  3. LLM com tool_use forçado + system prompt cached.
  4. Zod estrito + filtro veto. Veto bate → regenera 1× com nota explícita do termo.
  5. 2ª veto → **fallback estático em código** (`construirInsightEstatico`) usando números do snapshot — sem IA, sem risco.
  6. LLM down + cache existe → stale. LLM down sem cache → fallback estático (NUNCA 5xx).
- Backend: `GET /api/aluno/weekly-checkin` (cache-aware) + `POST /api/aluno/weekly-checkin/refresh` (rate-limit **2/semana/aluno**).
- Frontend: `WeeklyCheckinCard.tsx` no Dashboard, abaixo do StreakCard. 5 estados (loading/fresh/stale/empty/error). **Disclaimer fixo renderizado pelo frontend** ("Insight gerado por IA. Sempre consulte seu treinador...") — garantia de presença mesmo se LLM esquecer. Botão refresh oculto em estado `empty`.
- Testes: Backend **425** (era 395, +30). Frontend **201** (era 192, +9).
- Bundle: Aluno Dashboard chunk +0.72 KB Gzip (WeeklyCheckinCard inline; sem lib nova). Index principal **85.95 KB Gzip** intacto.
- Custo estimado: ~$0.0005/insight × 1/semana = ~$0.002/mês/aluno.

**Princípios reusados:**
- Cache TTL > cron (PR #28).
- IA narra retroativamente, humano prescreve (autoridade do coach intacta).
- Defesa em camadas: input_schema + Zod + filtro lexical + fallback estático.
- Notificação só em evento REAL (sem push push deste PR — descoberta orgânica no Dashboard).

**Coleira curta do prompt (regras negativas explícitas):**
- ❌ Mudança de carga/intensidade/volume/frequência.
- ❌ Contradizer prescrição em curso.
- ❌ Previsões de pace/RP/performance.
- ❌ Conselhos médicos/sono/hidratação/suplementação.
- ❌ Lesão/dor/fadiga/recuperação.
- ✅ Apenas narrativa retroativa factual com números do JSON.

---

## Sprint 11 — Gamificação & Retenção do Aluno 🔥

| PR | Tema | Status |
|----|------|--------|
| #31 | Conquistas event-driven + Streak counter + Push de marco | ✅ Implementado |

**PR #31 — entregue:**
- Prisma: model `ConquistaDesbloqueada` (1 row por unlock por aluno, `@@unique([alunoId, codigo])` pra idempotência blindada). Migration `20260521100000_conquista_desbloqueada`.
- Backend: **catálogo declarativo em código** (`src/data/conquistasCatalogo.js`) — 10 conquistas iniciais cobrindo streak (2/4/12/24/52 semanas), primeiro RP, pace 5K/10K, promoção BJJ. Adicionar nova = PR de código (review natural), NÃO migration.
- Backend: `src/services/streak.service.js` — **streak derivado, NÃO persistido**. SQL único com CTE de timeline (Treino + AtividadeStrava), `date_trunc('week', t)` alinhado ISO 8601, semana válida = ≥3 atividades. Segunda/terça da semana corrente sem treino NÃO punem o atleta (streak conta a partir da anterior válida). Função pura `computeStreak()` extraída pra testes.
- Backend: `src/lib/conquistasEngine.js` — motor com 4 avaliadores (STREAK / RP_FIRST / PACE_THRESHOLD / FAIXA_PROMOCAO). Idempotência em camadas (filtro `setJa` + DB `@@unique` + `createMany skipDuplicates`). **Fail-soft**: erro no engine NÃO propaga via try/catch; caller usa `queueMicrotask` (filosofia PR #27).
- Backend: `pushTriggers.payloadConquistaDesbloqueada()` — 1 push por desbloqueio, tag única (`conquista-{codigo}`) impede dup no SO.
- Backend: plug em `execucao.service` (STREAK + RP_FIRST + PACE_THRESHOLD após salvarExecucao) e `marcial.service` (FAIXA_PROMOCAO após registrarPromocao). Todos via `queueMicrotask` — caminho crítico inatingível.
- Backend: 2 endpoints REST: `GET /api/aluno/streak` + `GET /api/aluno/conquistas` (ambos com variante `/:alunoId/*` pra PROFESSOR vinculado).
- Frontend: `StreakCard.tsx` no topo do Dashboard do Aluno — 3 estados visuais (🔥 ≥4, 🌱 1-3, 💤 0 sem shame). Dot row últimas 12 semanas estilo GitHub. Card todo é link pra `/aluno/conquistas`. Badge "recorde N" quando histórico > atual.
- Frontend: `/aluno/conquistas` (rota lazy) com **estante** (desbloqueadas em ordem cronológica reversa) + **próximas** (locked com `hintLocked` em vez de `descricao` — sem spoiler). Deep-link `?destaque=CODIGO` ring-highlight no badge correspondente.
- Frontend: `ConquistaBadge.tsx` reutilizável (data-tier + data-desbloqueada + data-destaque attrs pra estilização e teste).
- Testes: Backend **395** (era 371, +24). Frontend **192** (era 179, +13).
- Bundle: Conquistas page chunk **1.43 KB Gzip** (lazy). Aluno Dashboard chunk +0.74 KB Gzip (StreakCard inline). Index principal **85.95 KB Gzip** (+0.07 KB do CSS dos novos componentes).

**Princípios mantidos do legado das Sprints anteriores:**
- Event-driven, sem cron (PR #27).
- Fire-and-forget no dispatch (PR #27).
- Cálculo > persistência quando barato (streak derivado).
- Catálogo em código > tabela quando schema estável.
- Notificação só em evento REAL transacional.
- Idempotência em camadas (filtro + unique + skipDuplicates).

---

## Sprint 10 — Coach Intelligence Layer 🧠

| PR | Tema | Status |
|----|------|--------|
| #28 | Coach Briefing Semanal (IA sintetiza assessoria) | ✅ Mergeado |
| #29 | AI Progression Suggestion (Workout Builder) | ✅ Mergeado |
| #30 | AI Plan Drafting (treino — nutrição postergada pra Sprint 11) | ✅ Implementado |

**PR #28 — entregue:**
- Prisma: model `CoachBriefing` (1 briefing ativo por professor, JSONB result+meta, TTL 24h via `expiresAt`). Migration `20260519100000_coach_briefing`.
- Backend: `src/services/coachBriefingData.service.js` — agregador puro (sem IA) que reusa `listAlertasProf` + lookup leve de planos/provas/modalidades. **Cap 50 alunos** no prompt, residual contado. **Privacidade**: nome encurtado `"Carlos M."` antes de ir pro LLM.
- Backend: `src/services/coachBriefing.service.js` — orquestra cache → snapshot → LLM (Anthropic Haiku 4.5, tool_use estruturado, prompt cached). **Fence pós-Zod** filtra alunoIds que não pertencem ao coach (defesa contra alucinação). **Stale fallback**: LLM down + cache existente → serve antigo com `stale: true`. Sem cache + LLM down → 504 honesto.
- Backend: `GET /coach/briefing` (cache-aware) + `POST /coach/briefing/refresh` (force-regen, rate-limit 3/h/coach).
- Frontend: `CoachBriefingCard.tsx` com **5 estados** (loading/empty/fresh/stale/error) + refresh manual. Alunos em alerta linkam pra `/professor/aluno/:id`. Integrado em `pages/professor/Dashboard.tsx`.
- Testes: Backend **325** (era 310, +15). Frontend **147** (era 139, +8).
- Bundle: Professor Dashboard chunk +0.66 KB Gzip (CoachBriefingCard inline). Index principal **85.89 KB Gzip** sem mudança.
- Custo estimado: ~$0.001/call → ~$0.030/mês/coach com cache TTL 24h.

**PR #29 — entregue:**
- Backend: `src/services/aiProgressionData.service.js` — **set-resolution snapshot** (últimas 5 execuções, sets crus com kg/reps/rpe) via GIN seek `@>` no JSON `Treino.detalhes`. Reusa padrão do `historicoCargas` (PR #7). Computa `rpeMedioRecente`, `houveFalhaDeReps` (drop >25% reps entre sets), `diasDesdeUltima`. Helper `checkProfessorOwnership` (anti billing-drain pré-LLM).
- Backend: `src/services/aiProgression.service.js` — orquestra ownership check → snapshot → Anthropic Haiku 4.5 tool_use → Zod estrito → Zod repair tolerante. **Branch dedicada MUSCULAÇÃO vs CALISTENIA** com system prompts distintos (calistenia: progressão pela string `reps`, kg sempre null mesmo se LLM teimar).
- Backend: `src/schemas/aiProgression.schemas.js` — `suggestedProgressionSchema` com **5 campos + `tipoProgressao` enum** (`intensidade`/`volume`/`manutencao`/`deload`). Request schema com `modalidade` discriminator.
- Backend: `POST /api/coach/ai-progression/exercise` — `protect` + `requireRole('PROFESSOR')` + ownership-check no service + **rate-limit 30/h/coach**.
- Frontend: `src/lib/api/aiProgression.ts` — client tipado.
- Frontend: `src/components/professor/ExerciseBlockAISuggest.tsx` — **botão 💡 + popover inline** com 4 estados (idle/loading/suggestion/error). Badge `tipoProgressao` colorido (intensidade=accent, volume=warn, manutencao=ink-muted, deload=danger). **HITL puro**: Aplicar preenche `series` + `reps` (parsing "8-10" → 10), kg/RPE/justificativa ficam visíveis como referência sem auto-fill de `cargaPctRP`.
- Frontend: integração em `FormMusculacao.tsx` (botão por bloco) + `Prescrever.tsx` (passa `alunoId` adiante).
- Testes: Backend **344** (era 325, +19). Frontend **163** (era 147, +16).
- Bundle: Prescrever chunk +1.27 KB Gzip (era 8.50 → 9.77). Index principal **85.88 KB Gzip** intacto.
- Custo estimado: ~$0.0003/sugestão. 8 exercícios × 1 click cada = ~$0.0024/treino criado.

**PR #30 — entregue:**
- **Migration nova**: `20260520100000_pg_trgm_exercicio` — `CREATE EXTENSION IF NOT EXISTS pg_trgm` + `CREATE INDEX gin_trgm_ops` em `Exercicio.nome`. Idempotente (re-run safe).
- Backend: `src/lib/exercicioMatch.js` — **fuzzy match batched** via UNNEST + LATERAL JOIN. Single round-trip Postgres pra N exercícios. Thresholds verde≥0.9 / laranja≥0.6 / vermelho<0.6. **Fallback ILIKE** gracioso quando pg_trgm indisponível (score artificial 0.5, todos laranjas, warning logado).
- Backend: `src/services/aiDraftTreino.service.js` — pipeline ACL → ownership pre-LLM (anti billing-drain) → contexto leve opcional do aluno → Anthropic Haiku 4.5 com tool_use + system cached → Zod estrito + repair tolerante → fuzzy match batch → hidratação de exercicioId/score/confianca → meta agregada.
- Backend: `src/schemas/aiDraft.schemas.js` — caps `MAX_DIAS=7`, `MAX_EXERCICIOS_POR_DIA=12`. **Defesa dupla**: JSON Schema da Anthropic (min/max) + Zod no servidor.
- Backend: `POST /api/coach/ai-draft/treino` com rate-limit **10/h/coach** (mais agressivo que progression — geração é 6x mais cara).
- Frontend: `lib/api/aiDraft.ts` + `AIDraftExercicioPreview.tsx` (semáforo verde/laranja/vermelho) + `AIDraftModal.tsx` (4 estados: prompt/loading/preview/error) **lazy chunk separado**.
- Frontend: Botão "✨ Gerar rotina com IA" no topo de musculação do Workout Builder. Aplica `diasSugeridos[0]` ao form atual (toast informa restantes); confirma overwrite se já há exercícios preenchidos.
- Testes: Backend **371** (era 344, +27). Frontend **179** (era 163, +16).
- Bundle: `AIDraftModal` lazy chunk **2.44 KB Gzip** (alvo era 5-7KB, ficou abaixo). Prescrever chunk **10.30 KB Gzip** (+0.53 KB do botão+handler+parseRepsRange). Index principal **85.88 KB Gzip** intacto.
- Custo estimado: ~$0.002/draft × ~5 drafts/dia/coach = ~$0.01/dia/coach.

---

## Sprint 10 — FECHADA 🧠💡🏗️

**3 PRs cravados em sequência cirúrgica (leitura → sugestão → geração):**
- #28 Read · síntese semanal cacheada
- #29 Suggest · progressão pontual HITL
- #30 Generate · esqueleto de rotina com fuzzy match catálogo

**Métricas Sprint 10:**
- Backend tests: 310 → **371** (+61, +20%).
- Frontend tests: 139 → **179** (+40, +29%).
- Index bundle Gzip: 85.89 → **85.88 KB** (-1 byte, lazy paying dividends).
- Migrations: +2 (`CoachBriefing`, `pg_trgm_exercicio`).
- Endpoints novos: 5 (`/coach/briefing` GET, `/coach/briefing/refresh` POST, `/coach/ai-progression/exercise` POST, `/coach/ai-draft/treino` POST).
- Custo IA total estimado por coach ativo: ~$0.04/mês (briefing $0.030 + progression $0.005 + draft $0.005).

**Tech-debt aberto:**
- VAPID hash check no boot do server (PR #26, ~30min) — alerta se key rotacionou silenciosamente.
- ESLint config legacy pre-existente — não bloqueia build/test.

---

## Sprint 9 — Interações Avançadas & IA (HCI + Push Era)

| PR | Tema | Status |
|----|------|--------|
| #25 | Diário de Voz BJJ com IA (Voice-to-JSON via Anthropic Claude tool_use) | ✅ Mergeado |
| #26 | Web Push Notifications (VAPID + injectManifest SW custom) | ✅ Mergeado |
| #27 | Triggers de Engajamento (Nutrição + Prescrição + Glória) | ✅ Implementado |

**PR #25 — entregue:**
- Backend: `POST /api/voice/parse-bjj` (protected + role ALUNO + rate-limit 20/dia/user). Anthropic Claude Haiku 4.5 com tool_use estruturado. Áudio in-memory (nunca toca disco/S3). Magic bytes detection (LGPD-friendly). Allowlist mime generosa Safari/iOS.
- Frontend: `VoiceDiary.tsx` lazy chunk **2.67 KB Gzip**. `voiceDrafts.ts` IndexedDB store TTL 7d. Banner de rascunho no remount resolve cenário vestiário→rua.
- Testes: Backend **271** (+28). Frontend **116** (+16).

**PR #26 — entregue:**
- Backend: `web-push` SDK + VAPID env vars (forever-coupled — rotação invalida tudo). Endpoints `GET /push/vapid-public-key` (público), `POST /push/subscriptions` (upsert idempotente), `DELETE /push/subscriptions` (scoped por userId), `POST /push/test` (dev-only). Service `push.service.dispatch({userId, payload})` é abstração única — fan-out via `Promise.allSettled`, cleanup inline em 410/404, `lastUsedAt` updates batch.
- Prisma: model `PushSubscription` (userId FK, endpoint UNIQUE, p256dh+auth, userAgent debug). Migration `20260518200000_push_subscriptions`.
- Frontend: **vite.config migrado de `generateSW` → `injectManifest`**. `src/sw.ts` custom porta runtimeCaching 1:1 + listeners `push` / `notificationclick` (foco de aba via `clients.matchAll` + `navigate`/`openWindow` fallback) / `pushsubscriptionchange` (re-subscribe automático).
- Frontend: `lib/push/registerPush.ts` com **detecção iOS Safari + standalone check** — 5 estados (`unsupported`, `ios-needs-install`, `denied`, `granted-unsubscribed`, `subscribed`). `NotificationsToggle.tsx` no perfil.
- Testes: Backend **294** (era 271, +23). Frontend **139** (era 116, +23).
- Bundle: `sw.mjs` **9.12 KB Gzip**. Perfil chunk +1.56 KB Gzip (NotificationsToggle inline). `index` principal **85.88 KB Gzip** (sem mudança).

**VAPID setup (one-time):**
```bash
npx web-push generate-vapid-keys
# Setar VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (mailto:),
# PUSH_ENABLED=true no .env de cada ambiente. NUNCA rotacionar — invalida
# todas subscriptions existentes.
```

**PR #27 — entregue:**
- `src/lib/pushTriggers.js` — **abstração única** com `firePush({userId, payload, trigger})`. Fire-and-forget via `queueMicrotask`, try/catch silencia erros, audit estruturado JSON em stdout (level info/warn/debug). Builders de payload centralizados (`payloadNovoPlanoAlimentar`, `payloadNovoTreinoPrescrito`, `payloadNovoRecorde` com **agregação anti-flood** 1 RP vs N RPs).
- **3 gatilhos plugados** event-driven puros:
  - `plano.service.createPlano` → push pro **aluno.userId** (NUTRI dispara, ALUNO recebe). URL `/aluno/perfil`.
  - `treino.service.clonarTreino` → push pro **aluno alvo.userId** (lookup mínimo via `select: {userId:true}`). URL `/aluno/dashboard`.
  - `execucao.service.salvarExecucao` → push pro **user.userId** se houver RPs novos. URL `/aluno/rps`. **Agregação**: 3 RPs num mesmo treino = 1 push agregado, não 3.
- Garantias: **push falhar nunca causa 5xx** no fluxo principal (queueMicrotask + catch). 503 (feature off) loga em debug — não polui stderr de dev.
- Sem novas rotas. Sem cron. Sem opt-out por categoria (decisão consciente — escopo cirúrgico).
- Testes: Backend **310** (era 294, +16). Frontend inalterado (UI não muda neste PR).
- Setup de teste: `setup-env.js` agora seta `DATABASE_URL` dummy — services importam pushTriggers → push.service → env transitivamente, todos testes precisam.

Aplicação web mobile-first para prescrição e execução de treinos
multi-modalidade (musculação, corrida, ciclismo, natação, triathlon, hyrox)
com módulos de evolução corporal, integração Strava, papéis de
Aluno / Professor / Nutricionista.

---

## 1. Árvore de pastas — `src/`

### Backend (`apex-training-backend/src/`)

```
src/
├── index.js                       # bootstrap Express + mount de rotas
├── lib/
│   ├── access.js                  # helpers de autorização compartilhados
│   ├── bodyfat.js                 # JP3/JP4/JP7 + Durnin-Womersley + Siri + IMC
│   ├── prisma.js                  # PrismaClient singleton
│   └── strava.js                  # adapter da API Strava (OAuth + atividades)
├── middleware/
│   ├── auth.middleware.js         # requireAuth + requireRole
│   └── errorHandler.js            # HttpError + handler global
├── schemas/                       # Zod por domínio
│   ├── auth.schemas.js
│   ├── evolucao.schemas.js
│   ├── execucao.schemas.js
│   ├── exercicio.schemas.js
│   ├── prova.schemas.js
│   ├── rotina.schemas.js
│   └── treino.schemas.js          # discriminated union por modalidade
├── controllers/                   # 1:1 com routes
│   ├── aluno.controller.js
│   ├── auth.controller.js
│   ├── evolucao.controller.js
│   ├── exercicio.controller.js
│   ├── nutri.controller.js
│   ├── professor.controller.js
│   ├── prova.controller.js
│   ├── rotina.controller.js
│   ├── rps.controller.js
│   ├── strava.controller.js
│   └── treino.controller.js
├── services/                      # regras de negócio
│   ├── aluno.service.js
│   ├── auth.service.js
│   ├── evolucao.service.js        # CRUD + recálculo automático IMC/%BF
│   ├── execucao.service.js        # salvar sets durante WorkoutLive
│   ├── exercicio.service.js
│   ├── nutri.service.js
│   ├── professor.service.js
│   ├── prova.service.js
│   ├── rotina.service.js          # criar/iniciar/reagendar/cascata
│   ├── rps.service.js
│   ├── strava.service.js
│   └── treino.service.js          # +historicoCargas
└── routes/
    ├── aluno.routes.js
    ├── auth.routes.js
    ├── evolucao.routes.js
    ├── exercicio.routes.js
    ├── nutri.routes.js
    ├── professor.routes.js
    ├── provas.routes.js
    ├── rotina.routes.js
    ├── rps.routes.js
    ├── strava.routes.js
    └── treinos.routes.js
```

```
prisma/
├── schema.prisma
├── seed.js                        # 3 alunos + prof + nutri + 32 exercícios + 3 rotinas
└── migrations/
    ├── 20260505000000_init/
    └── 20260505010000_evolucao_corporal/
```

### Frontend (`apex-training-frontend/src/`)

```
src/
├── App.tsx                        # rotas + ProtectedRoute por role
├── main.tsx
├── components/
│   ├── AlunoTabs.tsx              # nav inferior do aluno (4 tabs)
│   ├── ImageComparisonSlider.tsx  # before/after + FotosUploader
│   ├── Placeholder.tsx
│   ├── ProtectedRoute.tsx
│   ├── ReagendarButton.tsx
│   ├── TreinoCard.tsx             # card por modalidade c/ ícones
│   ├── auth/
│   │   ├── AuthShell.tsx
│   │   └── Field.tsx
│   ├── ui/                        # shadcn local
│   │   ├── card.tsx
│   │   ├── progress.tsx
│   │   ├── slider.tsx
│   │   └── tabs.tsx
│   └── workout/                   # tela de execução
│       ├── BottomTabs.tsx
│       ├── CorridaLive.tsx
│       ├── ExerciseCard.tsx
│       ├── FinalizeCTA.tsx
│       ├── Header.tsx
│       ├── OfflineBanner.tsx
│       ├── PRCelebration.tsx
│       ├── PhoneFrame.tsx
│       ├── ProgressStrip.tsx
│       ├── SaveBar.tsx
│       ├── SaveSerieBar.tsx
│       ├── SetsTable.tsx
│       ├── SetsTableLive.tsx
│       ├── SportChips.tsx
│       ├── WorkoutLive.tsx        # execução real (musculação)
│       ├── WorkoutScreen.tsx      # demo
│       ├── icons.tsx
│       └── types.ts
├── contexts/
│   ├── AuthContext.tsx
│   └── ThemeContext.tsx
├── hooks/
│   └── useExecucaoTreino.ts       # offline-first state machine
├── lib/
│   ├── api.ts                     # axios instance + interceptors
│   ├── api/
│   │   ├── alunoVinculos.ts
│   │   ├── evolucoes.ts
│   │   ├── execucao.ts
│   │   ├── exercicios.ts
│   │   ├── nutri.ts
│   │   ├── professor.ts
│   │   ├── provas.ts
│   │   ├── rotinas.ts
│   │   ├── rps.ts
│   │   ├── strava.ts
│   │   └── treinos.ts
│   ├── format.ts
│   ├── upload.ts                  # adapter mock S3 (uploadFotoMock / Stub S3)
│   └── utils.ts
├── pages/
│   ├── aluno/
│   │   ├── Calendario.tsx         # mensal + rotinas projetadas
│   │   ├── Dashboard.tsx
│   │   ├── Evolucao.tsx           # primeira versão (gráficos SVG)
│   │   ├── EvolucaoNova.tsx       # 2 cards modulares (Aluno / ISAK)
│   │   ├── Perfil.tsx
│   │   ├── Progresso.tsx          # tabs Desempenho + Evolução física
│   │   ├── RPs.tsx
│   │   └── Treino.tsx             # roteia musc/corrida/etc
│   ├── auth/
│   │   ├── Cadastro.tsx
│   │   ├── Login.tsx
│   │   └── StravaCallback.tsx
│   ├── nutricionista/
│   │   ├── AlunoDetalhe.tsx
│   │   └── Dashboard.tsx
│   └── professor/
│       ├── AlunoDetalhe.tsx
│       ├── Alunos.tsx
│       ├── Calendario.tsx
│       ├── Dashboard.tsx
│       ├── Exercicios.tsx         # catálogo CRUD
│       ├── Prescrever.tsx         # builder multi-sports
│       └── RotinaForm.tsx         # criar/editar rotina semanal
├── themes/
│   └── tokens.ts
└── types/
    └── treino.ts                  # mirror dos tipos do backend
```

---

## 2. Schema Prisma (`prisma/schema.prisma`)

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

// ── Enums ─────────────────────────────────────────────────────
enum Role           { ALUNO PROFESSOR NUTRICIONISTA }
enum Modalidade     { MUSCULACAO CORRIDA CICLISMO NATACAO TRIATHLON OUTRO }
enum StatusTreino   { PENDENTE EM_EXECUCAO CONCLUIDO PULADO }
enum DiaSemana      { DOM SEG TER QUA QUI SEX SAB }
enum AvaliadorTipo  { ALUNO NUTRICIONISTA PROFESSOR }
enum GrupoMuscular  {
  PEITO COSTAS OMBRO BICEPS TRICEPS ANTEBRACO
  ABDOMEN GLUTEO QUADRICEPS POSTERIOR PANTURRILHA
  CARDIO CORE OUTRO
}

// ── Identidade ────────────────────────────────────────────────
model User {
  id            String    @id @default(cuid())
  email         String    @unique
  senhaHash     String
  nome          String
  role          Role
  avatarUrl     String?
  criadoEm      DateTime  @default(now())
  atualizadoEm  DateTime  @updatedAt

  aluno         Aluno?
  professor     Professor?
  nutricionista Nutricionista?

  @@index([role])
}

model Aluno {
  id              String    @id @default(cuid())
  userId          String    @unique
  user            User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  dataNascimento  DateTime?
  pesoKg          Float?
  alturaCm        Int?
  stravaUserId    String?   @unique
  stravaToken     String?
  stravaRefresh   String?
  stravaExpiresAt DateTime?

  vinculosProf  VinculoProfessor[]
  vinculosNutri VinculoNutricionista[]
  treinos       Treino[]
  provas        Prova[]
  recordes      RecordePessoal[]
  atividades    AtividadeStrava[]
  rotinas       RotinaMusculacao[]
  evolucoes     EvolucaoCorporal[]
}

model Professor {
  id     String  @id @default(cuid())
  userId String  @unique
  user   User    @relation(fields: [userId], references: [id], onDelete: Cascade)
  bio    String?

  vinculos          VinculoProfessor[]
  treinosPrescritos Treino[]
  rotinas           RotinaMusculacao[]
}

model Nutricionista {
  id     String  @id @default(cuid())
  userId String  @unique
  user   User    @relation(fields: [userId], references: [id], onDelete: Cascade)
  crn    String?

  vinculos VinculoNutricionista[]
}

// ── Vínculos profissional ↔ aluno ─────────────────────────────
model VinculoProfessor {
  id          String    @id @default(cuid())
  alunoId     String
  professorId String
  aluno       Aluno     @relation(fields: [alunoId], references: [id], onDelete: Cascade)
  professor   Professor @relation(fields: [professorId], references: [id], onDelete: Cascade)
  criadoEm    DateTime  @default(now())

  @@unique([alunoId, professorId])
}

model VinculoNutricionista {
  id              String        @id @default(cuid())
  alunoId         String
  nutricionistaId String
  aluno           Aluno         @relation(fields: [alunoId], references: [id], onDelete: Cascade)
  nutricionista   Nutricionista @relation(fields: [nutricionistaId], references: [id], onDelete: Cascade)
  aceitoPeloAluno Boolean       @default(false)
  criadoEm        DateTime      @default(now())

  @@unique([alunoId, nutricionistaId])
}

// ── Treino: instância executável (multi-sport via JSON) ───────
model Treino {
  id            String           @id @default(cuid())
  alunoId       String
  professorId   String?
  rotinaId      String?
  aluno         Aluno            @relation(fields: [alunoId], references: [id], onDelete: Cascade)
  professor     Professor?       @relation(fields: [professorId], references: [id], onDelete: SetNull)
  rotina        RotinaMusculacao? @relation(fields: [rotinaId], references: [id], onDelete: SetNull)
  modalidade    Modalidade
  titulo        String
  dataAlvo      DateTime
  status        StatusTreino     @default(PENDENTE)
  detalhes      Json             // discriminated union por `tipo`
  iniciadoEm    DateTime?
  finalizadoEm  DateTime?
  reagendadoDe  DateTime?        // dataAlvo original antes de reagendar
  criadoEm      DateTime         @default(now())
  atualizadoEm  DateTime         @updatedAt

  @@index([alunoId, dataAlvo])
  @@index([status])
}

// detalhes JSON suporta: musculacao | corrida | ciclismo | natacao
//                        | triathlon | hyrox | outro
// — corrida: subtipos (BASE/RECOVERY/LONG/PROGRESSION/INTERVALOS/
//                       TEMPO/THRESHOLD/FARTLEK/HILL_REPEATS) + blocos
// — ciclismo: 7 zonas FTP + blocos
// — natacao: CSS base + blocos com offset CSS / RI
// — hyrox: AMRAP/EMOM/FOR_TIME/TABATA/INTERVAL/RUN/STATION

// ── Prova / RP / Strava ───────────────────────────────────────
model Prova {
  id         String     @id @default(cuid())
  alunoId    String
  aluno      Aluno      @relation(fields: [alunoId], references: [id], onDelete: Cascade)
  modalidade Modalidade
  nome       String
  data       DateTime
  detalhes   Json
  criadoEm   DateTime   @default(now())

  @@index([alunoId, data])
}

model RecordePessoal {
  id          String     @id @default(cuid())
  alunoId     String
  aluno       Aluno      @relation(fields: [alunoId], references: [id], onDelete: Cascade)
  modalidade  Modalidade
  exercicio   String
  metrica     String      // 'kg_x_reps' | 'tempo' | 'distancia' | 'potencia'
  valor       Float
  unidade     String
  reps        Int?
  dataRecorde DateTime    @default(now())
  treinoId    String?

  @@index([alunoId, exercicio])
}

model AtividadeStrava {
  id             String   @id @default(cuid())
  alunoId        String
  aluno          Aluno    @relation(fields: [alunoId], references: [id], onDelete: Cascade)
  stravaId       String   @unique
  tipo           String   // Run, Ride, Swim, etc.
  nome           String
  distanciaM     Float
  duracaoSeg     Int
  ritmoMedio     Float?
  fcMedia        Int?
  iniciadoEm     DateTime
  payloadRaw     Json
  sincronizadoEm DateTime @default(now())

  @@index([alunoId, iniciadoEm])
}

// ── Catálogo de exercícios + rotinas semanais ────────────────
model Exercicio {
  id            String         @id @default(cuid())
  nome          String         @unique
  videoUrl      String?
  imagemUrl     String?
  grupoMuscular GrupoMuscular?
  equipamento   String?
  instrucoes    String?
  criadoPorId   String?
  criadoEm      DateTime       @default(now())
  atualizadoEm  DateTime       @updatedAt

  rotinaExercicios RotinaExercicio[]

  @@index([grupoMuscular])
}

model RotinaMusculacao {
  id              String     @id @default(cuid())
  alunoId         String
  professorId     String
  nome            String
  diaSemana       DiaSemana
  vigenciaInicio  DateTime
  vigenciaFim     DateTime?  // null = aberta
  criadoEm        DateTime   @default(now())
  atualizadoEm    DateTime   @updatedAt

  aluno      Aluno     @relation(fields: [alunoId], references: [id], onDelete: Cascade)
  professor  Professor @relation(fields: [professorId], references: [id], onDelete: Cascade)
  exercicios RotinaExercicio[]
  treinos    Treino[]

  @@index([alunoId, diaSemana])
  @@index([alunoId, vigenciaInicio, vigenciaFim])
}

model RotinaExercicio {
  id          String  @id @default(cuid())
  rotinaId    String
  exercicioId String
  ordem       Int
  series      Int
  reps        Int?
  repsMin     Int?
  repsMax     Int?
  cargaPctRP  Float?
  cargaKg     Float?
  descansoSeg Int?
  observacao  String?

  rotina    RotinaMusculacao @relation(fields: [rotinaId], references: [id], onDelete: Cascade)
  exercicio Exercicio        @relation(fields: [exercicioId], references: [id], onDelete: Restrict)

  @@unique([rotinaId, ordem])
  @@index([rotinaId])
}

// ── Avaliação física / Evolução corporal ─────────────────────
model EvolucaoCorporal {
  id                String        @id @default(cuid())
  alunoId           String
  aluno             Aluno         @relation(fields: [alunoId], references: [id], onDelete: Cascade)

  avaliadorId       String?
  avaliadorTipo     AvaliadorTipo
  dataAvaliacao     DateTime      @default(now())

  pesoKg            Float?
  alturaCm          Int?
  imc               Float?        // recalculado no servidor
  percentualGordura Float?        // recalculado no servidor (clamp 3–60%)
  protocolo         String?       // ALUNO_FITA | ISAK_RESTRITO | JP3/4/7 | DURNIN_WOMERSLEY

  medidas           Json?         // ALUNO_FITA simples ou ISAK completo
  fotos             Json?         // { frente, lado, costas, extras[] }
  observacoes       String?

  criadoEm          DateTime      @default(now())
  atualizadoEm      DateTime      @updatedAt

  @@index([alunoId, dataAvaliacao])
  @@index([avaliadorTipo])
}
```

**Migrations versionadas:** `20260505000000_init`, `20260505010000_evolucao_corporal`.
Geradas via `prisma migrate diff` (usuário do banco sem permissão para
shadow database) e marcadas com `migrate resolve --applied`.

---

## 3. Dependências instaladas

### Backend (`apex-training-backend/package.json`)

| Categoria | Pacote | Versão | Por quê |
|---|---|---|---|
| Runtime | Node.js | ≥ 20 | engines |
| Web | `express` | ^4.21.1 | HTTP |
| Banco | `@prisma/client` | ^5.22.0 | ORM |
| Banco | `prisma` (dev) | ^5.22.0 | CLI / migrations |
| Validação | `zod` | ^3.23.8 | Schemas + discriminated unions |
| Auth | `bcryptjs` | ^2.4.3 | Hash de senha |
| Auth | `jsonwebtoken` | ^9.0.2 | JWT |
| Segurança | `helmet` | ^8.0.0 | headers |
| Segurança | `cors` | ^2.8.5 | CORS multi-origin (lista no .env) |
| Logs | `morgan` | ^1.10.0 | Access log |
| Config | `dotenv` | ^16.4.5 | .env |
| Dev | `nodemon` | ^3.1.7 | watch |

### Frontend (`apex-training-frontend/package.json`)

| Categoria | Pacote | Versão | Por quê |
|---|---|---|---|
| Core | `react` / `react-dom` | ^18.3.1 | — |
| Roteamento | `react-router-dom` | ^6.28.0 | rotas |
| HTTP | `axios` | ^1.7.7 | api client |
| Estado | `zustand` | ^5.0.1 | store leve (offline) |
| Charts | `recharts` | ^3.8.1 | LineChart, PieChart (donut) |
| UI primitivos | `@radix-ui/react-tabs` | ^1.1.13 | Tabs (Progresso) |
| UI primitivos | `@radix-ui/react-progress` | ^1.1.8 | Progress bar |
| UI primitivos | `@radix-ui/react-slider` | ^1.3.6 | Slider before/after |
| UI primitivos | `@radix-ui/react-slot` | ^1.1.1 | composição shadcn |
| Estilo | `class-variance-authority` | ^0.7.1 | variantes |
| Estilo | `clsx` + `tailwind-merge` | — | `cn` helper |
| Animação | `tailwindcss-animate` | ^1.0.7 | utilitários |
| Ícones | `lucide-react` | ^0.460.0 | icon set |
| Build | `vite` | ^5.4.11 | bundler |
| Build | `@vitejs/plugin-react` | ^4.3.3 | — |
| PWA | `vite-plugin-pwa` | ^0.21.1 | manifest + SW |
| TS | `typescript` | ^5.6.3 | — |
| Estilo | `tailwindcss` | ^3.4.15 | — |
| Estilo | `postcss` + `autoprefixer` | — | — |
| Lint | `eslint` (+ react-hooks, react-refresh) | ^9.15.0 | — |

---

## 4. API — endpoints funcionais

Base: `http://localhost:3333` em dev. Todos retornam JSON. Autenticação
via `Authorization: Bearer <jwt>` exceto rotas públicas (`/api/auth/*`).

### `/api/health` (público)
- `GET` — status do serviço

### `/api/auth`  ✅ 100%
| Método | Path | Descrição |
|---|---|---|
| `POST` | `/register` | cadastra User + perfil de role |
| `POST` | `/login` | retorna token JWT (7d) |
| `GET` | `/me` | usuário autenticado |

### `/api/aluno`  ✅
| Método | Path | Descrição |
|---|---|---|
| `GET` | `/professores` | lista profs vinculados |
| `GET` | `/nutricionistas` | lista nutris vinculados |
| `POST` | `/vincular` | aluno vincula a um prof |
| `POST` | `/solicitar` | solicita vínculo com nutri |
| `POST` | `/nutricionistas/:vinculoId/aceitar` | aceita pedido nutri |
| `DELETE` | `/nutricionistas/:vinculoId` | recusa nutri |
| `DELETE` | `/vinculo/:vinculoId` | remove prof |

### `/api/professor`  ✅
| Método | Path | Descrição |
|---|---|---|
| `GET` | `/dashboard` | KPIs (alunos, treinos da semana, etc.) |
| `GET` | `/alunos` | alunos vinculados c/ contagem pendentes |
| `GET` | `/aluno/:alunoId` | detalhe do aluno (treinos, RPs, próxima prova) |
| `GET` | `/calendario` | agenda mensal de todos os alunos |
| `GET` | `/atividades/:alunoId` | atividades Strava do aluno |

### `/api/nutri`  ✅
| Método | Path | Descrição |
|---|---|---|
| `GET` | `/dashboard` | KPIs do nutri |
| `GET` | `/aluno/:alunoId` | detalhe (gated por aceitação) |

### `/api/treinos`  ✅
| Método | Path | Descrição |
|---|---|---|
| `POST` | `/prescrever` | professor cria treino avulso |
| `GET` | `/historico-cargas?nomes=A,B` | última kg/reps por exercício do aluno |
| `GET` | `/detalhe/:id` | um treino + access control |
| `POST` | `/:id/salvar` | salva execução (sets realizados) |
| `DELETE` | `/:id` | cancela treino |
| `GET` | `/:alunoId` | lista do aluno c/ filtros |

### `/api/rotinas`  ✅
| Método | Path | Descrição |
|---|---|---|
| `GET` | `/` | lista rotinas (filtros alunoId/diaSemana/ativasEm) |
| `GET` | `/:id` | detalhe |
| `GET` | `/aluno/:alunoId/dia` | rotinas vigentes hoje |
| `POST` | `/` | professor cria rotina semanal |
| `PUT` | `/:id` | edita (substitui exercícios) |
| `DELETE` | `/:id` | exclui + cascata em treinos pendentes |
| `POST` | `/:id/iniciar` | aluno gera instância Treino |
| `PATCH` | `/treinos/:id/reagendar` | aluno move dataAlvo |

### `/api/exercicios`  ✅
| Método | Path | Descrição |
|---|---|---|
| `GET` | `/` | catálogo (filtros q + grupo) |
| `GET` | `/:id` | detalhe |
| `POST` | `/` | criar (PROFESSOR) |
| `PUT` | `/:id` | editar (PROFESSOR) |
| `DELETE` | `/:id` | excluir (bloqueia se em uso por rotina) |

### `/api/evolucoes`  ✅
| Método | Path | Descrição |
|---|---|---|
| `POST` | `/preview` | calcula IMC + %BF sem persistir (UI tempo real) |
| `GET` | `/` | histórico (filtros desde/ate/limit) |
| `GET` | `/:id` | detalhe |
| `POST` | `/` | criar (recálculo IMC/%BF no servidor) |
| `PUT` | `/:id` | editar (aluno só as próprias) |
| `DELETE` | `/:id` | excluir (aluno só as próprias) |

### `/api/provas`  ✅
| Método | Path | Descrição |
|---|---|---|
| `GET` | `/:alunoId` | lista provas |
| `POST` | `/` | criar prova |
| `PUT` | `/:id` | editar |
| `DELETE` | `/:id` | excluir |

### `/api/rps`  ✅
| Método | Path | Descrição |
|---|---|---|
| `GET` | `/:alunoId` | recordes pessoais do aluno |
| `POST` | `/` | criar RP manual |

### `/api/strava`  ✅ (env preenchido necessário)
| Método | Path | Descrição |
|---|---|---|
| `GET` | `/status` | conectado? |
| `POST` | `/connect` | troca authorization code → tokens |
| `POST` | `/sync` | importa atividades |
| `POST` | `/disconnect` | revoga tokens locais |

---

## Modelos JSON `detalhes` (Treino)

| `tipo` | Suporte | Notas |
|---|---|---|
| `musculacao` | ✅ produção | snapshot de RotinaExercicio + sets realizados |
| `corrida` | ✅ produção | subtipos + blocos dinâmicos |
| `ciclismo` | ✅ produção | 7 zonas FTP + blocos |
| `natacao` | ✅ produção | CSS base + offsets |
| `hyrox` | ✅ schema + form | sem tela de execução dedicada ainda |
| `triathlon` | ⚠️ schema | UI básica (placeholder) |
| `outro` | ✅ | descrição livre |

## Cálculos no servidor (`src/lib/bodyfat.js`)

| Protocolo | Sítios | Idade |
|---|---|---|
| `JP3` | M: peit/abd/coxa · F: tri/supra/coxa | sim |
| `JP4` | tri/supra/abd/coxa | sim |
| `JP7` | peit/axil/tri/sub/abd/supra/coxa | sim |
| `DURNIN_WOMERSLEY` | bi/tri/sub/supra | tabela por faixa etária × sexo |

Densidade → Siri → clamp `[3, 60]%`.

---

## Branches & deploy

| Repo | dev | main |
|---|---|---|
| backend | `db76ef1` | `af04a67` (Merge dev) |
| frontend | `cc3cd3b` | `e517ba2` (Merge dev) |

`main` recebe via merge no-ff de `dev`. Ainda **sem** CI/CD configurado.

## Pendências críticas

1. **Strava OAuth** — env (`STRAVA_CLIENT_ID/SECRET`) vazio em dev.
2. **Upload de fotos** — adapter em `src/lib/upload.ts` é mock data URL;
   precisa endpoint presign-PUT no backend pra trocar pro S3.
3. **PWA** — `vite-plugin-pwa` instalado mas manifest/SW não validado.
4. **Testes** — sem Vitest / Jest no projeto.
5. **CI/CD** — sem GitHub Actions; deploy manual.
6. **JWT_SECRET** já com fail-fast em produção; falta secret manager
   (Vault/SSM/Doppler) em vez de `.env`.
7. **HYROX no enum Modalidade** — frontend mapeia pra `OUTRO` com
   `detalhes.tipo='hyrox'`. Migration futura adicionando o valor ao
   enum padronizaria.
