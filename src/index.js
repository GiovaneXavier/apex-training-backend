import 'dotenv/config';
import express from 'express';
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
import { errorHandler } from './middleware/errorHandler.js';

const app = express();

app.use(helmet());
const corsOrigins = (process.env.CORS_ORIGIN || '*')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
app.use(cors({
  origin: corsOrigins.includes('*') ? '*' : corsOrigins,
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

app.use((req, res) => res.status(404).json({ error: 'NotFound', path: req.path }));
app.use(errorHandler);

const PORT = Number(process.env.PORT) || 3333;
app.listen(PORT, () => {
  console.log(`[apex-training] API on http://localhost:${PORT}`);
});
