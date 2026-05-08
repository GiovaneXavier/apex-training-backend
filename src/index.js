import 'dotenv/config';
import express from 'express';

// Validação fail-fast de segredos críticos.
// Em produção, JWT_SECRET ausente, vazio ou com placeholders conhecidos
// faz o processo terminar — preferir derrubar a subir inseguro.
const JWT_SECRET = process.env.JWT_SECRET ?? '';
const PLACEHOLDER_SECRETS = new Set([
  '', 'change-me', 'change-me-in-production', 'secret', 'changeme',
]);
if (process.env.NODE_ENV === 'production') {
  if (PLACEHOLDER_SECRETS.has(JWT_SECRET) || JWT_SECRET.length < 32) {
    console.error('[apex-training] FATAL: JWT_SECRET ausente, fraco ou placeholder em produção.');
    console.error('Gere com: node -e "console.log(require(\\"crypto\\").randomBytes(48).toString(\\"base64\\"))"');
    process.exit(1);
  }
} else if (PLACEHOLDER_SECRETS.has(JWT_SECRET)) {
  console.warn('[apex-training] aviso: JWT_SECRET é placeholder. OK em dev, NÃO suba pra produção.');
}

import cors from 'cors';
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

app.use(helmet());

// Origens permitidas:
// - FRONTEND_URL: domínio do deploy (Vercel) — fonte da verdade em prod
// - CORS_ORIGIN: lista CSV legada/local (localhost dev, IP da rede, staging)
// Une os dois e deduplica. Se CORS_ORIGIN='*', mantém wildcard (apenas dev).
const csvOrigins = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const frontendUrl = (process.env.FRONTEND_URL || '').trim();
const wildcard = csvOrigins.includes('*');
const corsOrigins = wildcard
  ? '*'
  : Array.from(new Set([...csvOrigins, frontendUrl].filter(Boolean)));
app.use(cors({
  origin: corsOrigins.length === 0 ? false : corsOrigins,
  credentials: true,
}));
app.use(express.json({ limit: '1mb' }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

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
// `import.meta.url === pathToFileURL(argv[1])` é o equivalente ESM ao
// CommonJS `require.main === module`.
import { fileURLToPath } from 'node:url';
import { argv } from 'node:process';
if (fileURLToPath(import.meta.url) === argv[1]) {
  // Render injeta PORT — default 3000 (convenção da plataforma).
  // 0.0.0.0 é obrigatório em containers/PaaS, senão Render derruba o serviço.
  const PORT = Number(process.env.PORT) || 3000;
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[apex-training] API on port ${PORT}`);
  });
}
