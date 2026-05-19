import 'dotenv/config';

// Validação fail-fast de TODAS as envs antes de qualquer outra coisa.
// Se faltar algo crítico (ou estiver mal formado), o processo termina aqui
// com mensagem clara em vez de quebrar no primeiro request.
import { env } from './lib/env.js';

// PR #34 — Sentry SOBE ANTES de qualquer outro require. SDK precisa
// enganchar http/express auto-instrument. No-op quando SENTRY_DSN ausente
// ou NODE_ENV=test → zero overhead em dev/test.
import { initSentry } from './lib/sentry.js';
initSentry();

import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import morgan from 'morgan';

import authRoutes from './routes/auth.routes.js';
import treinosRoutes from './routes/treinos.routes.js';
import provasRoutes from './routes/provas.routes.js';
import professorRoutes from './routes/professor.routes.js';
import nutriRoutes from './routes/nutri.routes.js';
import alunoRoutes from './routes/aluno.routes.js';
import rpsRoutes from './routes/rps.routes.js';
import stravaRoutes from './routes/strava.routes.js';
import exercicioRoutes from './routes/exercicio.routes.js';
import rotinaRoutes from './routes/rotina.routes.js';
import evolucaoRoutes from './routes/evolucao.routes.js';
import uploadRoutes from './routes/upload.routes.js';
import planoRoutes from './routes/plano.routes.js';
import marcialRoutes from './routes/marcial.routes.js';
import voiceRoutes from './routes/voice.routes.js';
import pushRoutes from './routes/push.routes.js';
import coachBriefingRoutes from './routes/coachBriefing.routes.js';
import { errorHandler } from './middleware/errorHandler.js';

const app = express();

// Render/Vercel/Heroku ficam atrás de load balancer; sem trust proxy,
// req.ip vira o IP do LB e o rate-limit por IP fica inútil. 1 = um
// nível de proxy (suficiente pras plataformas que usamos).
if (env.isProd) app.set('trust proxy', 1);

// PR #13 (audit 2.5 + 2.22) — Helmet endurecido pra API JSON.
//
// O servidor só responde JSON; não tem motivo pra um navegador
// interpretar qualquer payload daqui como HTML/JS. CSP "default-src
// 'none'" garante que mesmo se uma rota errada vazasse HTML, nada
// externo carrega.
//
// Frontend tem CSP separada (meta tag no index.html, ver
// apex-training-frontend/index.html) — só ali faz sentido liberar S3
// para img, Strava pra perfil, etc.
//
// crossOriginResourcePolicy: 'same-site' impede que outro site embede
// recursos nossos via <img>/<script>. Pra dev (CORS_ORIGIN='*') ainda
// vale, porque o objetivo é proteger contra Spectre-like e leak de
// recursos por outros sites, não substituir CORS.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
        formAction: ["'none'"],
        baseUri: ["'none'"],
      },
    },
    crossOriginResourcePolicy: { policy: 'same-site' },
    referrerPolicy: { policy: 'no-referrer' },
    // HSTS só faz sentido quando o app está atrás de HTTPS sempre.
    // Render/Vercel terminam TLS no edge; em dev (http://localhost) o
    // header é ignorado pelo browser então não atrapalha.
    strictTransportSecurity: {
      maxAge: 60 * 60 * 24 * 365, // 1 ano
      includeSubDomains: true,
      preload: false,
    },
  }),
);

// Origens CORS já normalizadas/deduplicadas em env.corsOrigins.
// Wildcard '*' só é permitido em dev (validação em env.js bloqueia em prod).
app.use(cors({
  origin: env.corsOrigins === '*'
    ? '*'
    : (env.corsOrigins.length === 0 ? false : env.corsOrigins),
  credentials: true,
}));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(morgan(env.isProd ? 'combined' : 'dev'));

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'apex-training-backend', version: '0.1.0' });
});

app.use('/api/auth', authRoutes);
app.use('/api/treinos', treinosRoutes);
app.use('/api/provas', provasRoutes);
app.use('/api/professor', professorRoutes);
app.use('/api/nutri', nutriRoutes);
app.use('/api/aluno', alunoRoutes);
app.use('/api/rps', rpsRoutes);
app.use('/api/strava', stravaRoutes);
app.use('/api/exercicios', exercicioRoutes);
app.use('/api/rotinas', rotinaRoutes);
app.use('/api/evolucoes', evolucaoRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/planos-alimentares', planoRoutes);
app.use('/api/marcial', marcialRoutes);
app.use('/api/voice', voiceRoutes);
app.use('/api/push', pushRoutes);
app.use('/api/coach', coachBriefingRoutes);

app.use((req, res) => res.status(404).json({ error: 'NotFound', path: req.path }));
app.use(errorHandler);

export { app };

// Listen apenas quando rodado direto (não em testes que importam o módulo).
import { fileURLToPath } from 'node:url';
import { argv } from 'node:process';
if (fileURLToPath(import.meta.url) === argv[1]) {
  // 0.0.0.0 é obrigatório em containers/PaaS.
  app.listen(env.PORT, '0.0.0.0', () => {
    console.log(`[apex-training] API on port ${env.PORT} (${env.NODE_ENV})`);
  });
}
