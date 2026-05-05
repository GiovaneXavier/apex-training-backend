# Apex Training — Status do Projeto

**Data:** 2026-05-05
**Branches:** `dev` (working), `main` (sincronizado com `dev`)
**Repos:** `apex-training-backend` · `apex-training-frontend`

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
