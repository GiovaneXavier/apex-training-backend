import 'dotenv/config';

// Validação fail-fast de TODAS as envs antes de qualquer outra coisa.
// Se faltar algo crítico (ou estiver mal formado), o processo termina aqui
// com mensagem clara em vez de quebrar no primeiro request.
import { env } from './lib/env.js';

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
import { errorHandler } from './middleware/errorHandler.js';

const app = express();

// Render/Vercel/Heroku ficam atrás de load balancer; sem trust proxy,
// req.ip vira o IP do LB e o rate-limit por IP fica inútil. 1 = um
// nível de proxy (suficiente pras plataformas que usamos).
if (env.isProd) app.set('trust proxy', 1);

app.use(helmet());

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
