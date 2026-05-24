import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

function diaRel(offset) {
  const d = new Date();
  d.setHours(7, 0, 0, 0);
  d.setDate(d.getDate() + offset);
  return d;
}

async function upsertUser({ email, senha, nome, role, extra = {} }) {
  const senhaHash = await bcrypt.hash(senha, 10);
  const user = await prisma.user.upsert({
    where: { email },
    update: { nome, role },
    create: { email, senhaHash, nome, role },
  });

  if (role === 'ALUNO') {
    await prisma.aluno.upsert({
      where: { userId: user.id },
      update: extra,
      create: { userId: user.id, ...extra },
    });
  } else if (role === 'PROFESSOR') {
    await prisma.professor.upsert({
      where: { userId: user.id },
      update: extra,
      create: { userId: user.id, ...extra },
    });
  } else if (role === 'NUTRICIONISTA') {
    await prisma.nutricionista.upsert({
      where: { userId: user.id },
      update: extra,
      create: { userId: user.id, ...extra },
    });
  }

  return user;
}

async function main() {
  console.log('Seeding…');

  // PR #41c-hotfix — email reservado: admin@apex.com agora é EXCLUSIVO
  // do seed-admin.js (role=ADMIN). Este professor de teste usa
  // professor@apex.com pra evitar colisão entre seed.js (dev) e
  // seed-admin.js (operações). Mantém senha admin123 pra preservar
  // hábito de QA.
  const profUser = await upsertUser({
    email: 'professor@apex.com', senha: 'admin123', nome: 'Professor Head',
    role: 'PROFESSOR', extra: { bio: 'Treinador head' },
  });
  const nutriUser = await upsertUser({
    email: 'nutri@apex.com', senha: 'nutri123', nome: 'Nutri Teste',
    role: 'NUTRICIONISTA', extra: { crn: 'CRN-12345' },
  });
  const aluno1User = await upsertUser({
    email: 'aluno@apex.com', senha: 'aluno123', nome: 'Aluno Teste',
    role: 'ALUNO',
    extra: { dataNascimento: new Date('1995-03-15'), pesoKg: 75.5, alturaCm: 178 },
  });
  const aluno2User = await upsertUser({
    email: 'maria@apex.com', senha: 'maria123', nome: 'Maria Corredora',
    role: 'ALUNO',
    extra: { dataNascimento: new Date('1992-08-22'), pesoKg: 60.0, alturaCm: 165 },
  });
  const aluno3User = await upsertUser({
    email: 'pedro@apex.com', senha: 'pedro123', nome: 'Pedro Triatleta',
    role: 'ALUNO',
    extra: { dataNascimento: new Date('1988-11-03'), pesoKg: 72.0, alturaCm: 180 },
  });

  const prof = await prisma.professor.findUniqueOrThrow({ where: { userId: profUser.id } });
  const nutri = await prisma.nutricionista.findUniqueOrThrow({ where: { userId: nutriUser.id } });
  const a1 = await prisma.aluno.findUniqueOrThrow({ where: { userId: aluno1User.id } });
  const a2 = await prisma.aluno.findUniqueOrThrow({ where: { userId: aluno2User.id } });
  const a3 = await prisma.aluno.findUniqueOrThrow({ where: { userId: aluno3User.id } });
  const alunos = [a1, a2, a3];

  for (const aluno of alunos) {
    await prisma.vinculoProfessor.upsert({
      where: { alunoId_professorId: { alunoId: aluno.id, professorId: prof.id } },
      update: {}, create: { alunoId: aluno.id, professorId: prof.id },
    });
    await prisma.vinculoNutricionista.upsert({
      where: { alunoId_nutricionistaId: { alunoId: aluno.id, nutricionistaId: nutri.id } },
      update: { aceitoPeloAluno: true },
      create: { alunoId: aluno.id, nutricionistaId: nutri.id, aceitoPeloAluno: true },
    });
  }

  // wipe data dos alunos
  const ids = alunos.map((a) => a.id);
  await prisma.treino.deleteMany({ where: { alunoId: { in: ids } } });
  await prisma.prova.deleteMany({ where: { alunoId: { in: ids } } });
  await prisma.recordePessoal.deleteMany({ where: { alunoId: { in: ids } } });
  await prisma.atividadeStrava.deleteMany({ where: { alunoId: { in: ids } } });

  // ===== Catálogo global de exercícios =====
  const catalogo = [
    // PEITO
    { nome: 'Supino Reto', grupoMuscular: 'PEITO', equipamento: 'Barra' },
    { nome: 'Supino Inclinado', grupoMuscular: 'PEITO', equipamento: 'Barra' },
    { nome: 'Supino Declinado', grupoMuscular: 'PEITO', equipamento: 'Barra' },
    { nome: 'Crucifixo Inclinado', grupoMuscular: 'PEITO', equipamento: 'Halter' },
    { nome: 'Crossover', grupoMuscular: 'PEITO', equipamento: 'Cabo' },
    { nome: 'Peck Deck', grupoMuscular: 'PEITO', equipamento: 'Máquina' },
    // COSTAS
    { nome: 'Puxada Frente', grupoMuscular: 'COSTAS', equipamento: 'Cabo' },
    { nome: 'Remada Curvada', grupoMuscular: 'COSTAS', equipamento: 'Barra' },
    { nome: 'Remada Sentada', grupoMuscular: 'COSTAS', equipamento: 'Cabo' },
    { nome: 'Barra Fixa', grupoMuscular: 'COSTAS', equipamento: 'Peso corporal' },
    { nome: 'Pull Down', grupoMuscular: 'COSTAS', equipamento: 'Cabo' },
    // OMBRO
    { nome: 'Desenvolvimento com Halter', grupoMuscular: 'OMBRO', equipamento: 'Halter' },
    { nome: 'Elevação Lateral', grupoMuscular: 'OMBRO', equipamento: 'Halter' },
    { nome: 'Elevação Frontal', grupoMuscular: 'OMBRO', equipamento: 'Halter' },
    // BÍCEPS / TRÍCEPS
    { nome: 'Rosca Direta', grupoMuscular: 'BICEPS', equipamento: 'Barra' },
    { nome: 'Rosca Alternada', grupoMuscular: 'BICEPS', equipamento: 'Halter' },
    { nome: 'Rosca Martelo', grupoMuscular: 'BICEPS', equipamento: 'Halter' },
    { nome: 'Tríceps Corda', grupoMuscular: 'TRICEPS', equipamento: 'Cabo' },
    { nome: 'Tríceps Testa', grupoMuscular: 'TRICEPS', equipamento: 'Barra W' },
    { nome: 'Tríceps Banco', grupoMuscular: 'TRICEPS', equipamento: 'Peso corporal' },
    // PERNA
    { nome: 'Agachamento Livre', grupoMuscular: 'QUADRICEPS', equipamento: 'Barra' },
    { nome: 'Leg Press 45°', grupoMuscular: 'QUADRICEPS', equipamento: 'Máquina' },
    { nome: 'Cadeira Extensora', grupoMuscular: 'QUADRICEPS', equipamento: 'Máquina' },
    { nome: 'Stiff', grupoMuscular: 'POSTERIOR', equipamento: 'Halter' },
    { nome: 'Levantamento Terra', grupoMuscular: 'POSTERIOR', equipamento: 'Barra' },
    { nome: 'Mesa Flexora', grupoMuscular: 'POSTERIOR', equipamento: 'Máquina' },
    { nome: 'Cadeira Adutora', grupoMuscular: 'GLUTEO', equipamento: 'Máquina' },
    { nome: 'Hip Thrust', grupoMuscular: 'GLUTEO', equipamento: 'Barra' },
    { nome: 'Panturrilha em Pé', grupoMuscular: 'PANTURRILHA', equipamento: 'Máquina' },
    // CORE
    { nome: 'Prancha', grupoMuscular: 'CORE', equipamento: 'Peso corporal' },
    { nome: 'Abdominal Crunch', grupoMuscular: 'ABDOMEN', equipamento: 'Peso corporal' },
    { nome: 'Russian Twist', grupoMuscular: 'ABDOMEN', equipamento: 'Halter' },
  ];
  for (const ex of catalogo) {
    await prisma.exercicio.upsert({
      where: { nome: ex.nome },
      update: { grupoMuscular: ex.grupoMuscular, equipamento: ex.equipamento, criadoPorId: prof.id },
      create: { ...ex, criadoPorId: prof.id },
    });
  }
  const exMap = new Map((await prisma.exercicio.findMany()).map((e) => [e.nome, e]));

  // ===== Rotinas de musculação para aluno1 =====
  await prisma.rotinaMusculacao.deleteMany({ where: { alunoId: a1.id } });

  const hojeRot = new Date(); hojeRot.setHours(0, 0, 0, 0);
  const fim3meses = new Date(hojeRot); fim3meses.setMonth(fim3meses.getMonth() + 3);

  await prisma.rotinaMusculacao.create({
    data: {
      alunoId: a1.id, professorId: prof.id,
      nome: 'Treino A — Peito + Tríceps',
      diaSemana: 'SEG',
      vigenciaInicio: hojeRot,
      vigenciaFim: fim3meses,
      exercicios: {
        create: [
          { exercicioId: exMap.get('Supino Reto').id, ordem: 0, series: 4, reps: 8, cargaPctRP: 80, descansoSeg: 120 },
          { exercicioId: exMap.get('Supino Inclinado').id, ordem: 1, series: 3, reps: 10, cargaPctRP: 75, descansoSeg: 90 },
          { exercicioId: exMap.get('Crossover').id, ordem: 2, series: 3, reps: 15, cargaPctRP: 60, descansoSeg: 60 },
          { exercicioId: exMap.get('Tríceps Corda').id, ordem: 3, series: 3, reps: 15, cargaPctRP: 60, descansoSeg: 60 },
          { exercicioId: exMap.get('Tríceps Testa').id, ordem: 4, series: 3, reps: 12, cargaPctRP: 65, descansoSeg: 75 },
        ],
      },
    },
  });

  await prisma.rotinaMusculacao.create({
    data: {
      alunoId: a1.id, professorId: prof.id,
      nome: 'Treino B — Costas + Bíceps',
      diaSemana: 'QUA',
      vigenciaInicio: hojeRot,
      vigenciaFim: fim3meses,
      exercicios: {
        create: [
          { exercicioId: exMap.get('Barra Fixa').id, ordem: 0, series: 4, reps: 8, descansoSeg: 120 },
          { exercicioId: exMap.get('Remada Curvada').id, ordem: 1, series: 4, reps: 10, cargaPctRP: 75, descansoSeg: 90 },
          { exercicioId: exMap.get('Puxada Frente').id, ordem: 2, series: 3, reps: 12, cargaPctRP: 70, descansoSeg: 90 },
          { exercicioId: exMap.get('Rosca Direta').id, ordem: 3, series: 3, reps: 12, cargaPctRP: 70, descansoSeg: 75 },
          { exercicioId: exMap.get('Rosca Alternada').id, ordem: 4, series: 3, reps: 12, cargaPctRP: 65, descansoSeg: 60 },
        ],
      },
    },
  });

  await prisma.rotinaMusculacao.create({
    data: {
      alunoId: a1.id, professorId: prof.id,
      nome: 'Treino C — Pernas',
      diaSemana: 'SEX',
      vigenciaInicio: hojeRot,
      vigenciaFim: fim3meses,
      exercicios: {
        create: [
          { exercicioId: exMap.get('Agachamento Livre').id, ordem: 0, series: 5, reps: 5, cargaPctRP: 85, descansoSeg: 180 },
          { exercicioId: exMap.get('Leg Press 45°').id, ordem: 1, series: 4, reps: 12, cargaPctRP: 75, descansoSeg: 120 },
          { exercicioId: exMap.get('Stiff').id, ordem: 2, series: 4, reps: 10, cargaPctRP: 70, descansoSeg: 90 },
          { exercicioId: exMap.get('Cadeira Extensora').id, ordem: 3, series: 3, reps: 15, cargaPctRP: 60, descansoSeg: 75 },
          { exercicioId: exMap.get('Panturrilha em Pé').id, ordem: 4, series: 4, reps: 15, descansoSeg: 60 },
        ],
      },
    },
  });

  // ===== Aluno 1 — Musculação =====
  const treinosA1 = [
    { offset: -7, status: 'CONCLUIDO', titulo: 'Treino A — Peito + Tríceps', exs: [
      { nome: 'Supino Reto', prescrito: { series: 4, reps: 10, cargaPctRP: 75, descansoSeg: 90 },
        realizado: [{ kg: 80, reps: 10 }, { kg: 80, reps: 10 }, { kg: 82, reps: 9 }, { kg: 80, reps: 8 }] },
      { nome: 'Supino Inclinado', prescrito: { series: 3, reps: 12, cargaPctRP: 70, descansoSeg: 90 },
        realizado: [{ kg: 60, reps: 12 }, { kg: 60, reps: 12 }, { kg: 60, reps: 11 }] },
      { nome: 'Tríceps Corda', prescrito: { series: 3, reps: 15, cargaPctRP: 60, descansoSeg: 60 },
        realizado: [{ kg: 25, reps: 15 }, { kg: 25, reps: 14 }, { kg: 25, reps: 12 }] },
    ] },
    { offset: -5, status: 'CONCLUIDO', titulo: 'Treino B — Costas + Bíceps', exs: [
      { nome: 'Puxada Frente', prescrito: { series: 4, reps: 10 },
        realizado: [{ kg: 70, reps: 10 }, { kg: 70, reps: 10 }, { kg: 72, reps: 9 }, { kg: 72, reps: 8 }] },
      { nome: 'Remada Curvada', prescrito: { series: 3, reps: 10 },
        realizado: [{ kg: 60, reps: 10 }, { kg: 60, reps: 10 }, { kg: 60, reps: 9 }] },
      { nome: 'Rosca Direta', prescrito: { series: 3, reps: 12 },
        realizado: [{ kg: 20, reps: 12 }, { kg: 20, reps: 11 }, { kg: 20, reps: 10 }] },
    ] },
    { offset: -3, status: 'CONCLUIDO', titulo: 'Treino C — Pernas', exs: [
      { nome: 'Agachamento Livre', prescrito: { series: 5, reps: 5 },
        realizado: [{ kg: 100, reps: 5 }, { kg: 100, reps: 5 }, { kg: 100, reps: 5 }, { kg: 105, reps: 5 }, { kg: 105, reps: 4 }] },
      { nome: 'Leg Press', prescrito: { series: 4, reps: 12 },
        realizado: [{ kg: 200, reps: 12 }, { kg: 200, reps: 12 }, { kg: 220, reps: 10 }, { kg: 220, reps: 10 }] },
    ] },
    { offset: 0, status: 'PENDENTE', titulo: 'Treino A — Peito + Tríceps', exs: [
      { nome: 'Supino Reto', prescrito: { series: 4, reps: 8, cargaPctRP: 80, descansoSeg: 120 } },
      { nome: 'Supino Inclinado', prescrito: { series: 3, reps: 10, cargaPctRP: 75, descansoSeg: 90 } },
      { nome: 'Crossover', prescrito: { series: 3, reps: 15, cargaPctRP: 60 } },
      { nome: 'Tríceps Testa', prescrito: { series: 3, reps: 12 } },
    ] },
    { offset: 2, status: 'PENDENTE', titulo: 'Treino B — Costas + Bíceps', exs: [
      { nome: 'Barra Fixa', prescrito: { series: 4, reps: 8 } },
      { nome: 'Remada Sentada', prescrito: { series: 3, reps: 10 } },
      { nome: 'Rosca Alternada', prescrito: { series: 3, reps: 12 } },
    ] },
    { offset: 4, status: 'PENDENTE', titulo: 'Treino C — Pernas', exs: [
      { nome: 'Agachamento Livre', prescrito: { series: 5, reps: 5, cargaPctRP: 85 } },
      { nome: 'Stiff', prescrito: { series: 4, reps: 10 } },
      { nome: 'Cadeira Extensora', prescrito: { series: 3, reps: 15 } },
    ] },
  ];
  for (const t of treinosA1) {
    await prisma.treino.create({
      data: {
        alunoId: a1.id, professorId: prof.id, modalidade: 'MUSCULACAO',
        titulo: t.titulo, dataAlvo: diaRel(t.offset), status: t.status,
        detalhes: { tipo: 'musculacao', exercicios: t.exs },
        finalizadoEm: t.status === 'CONCLUIDO' ? diaRel(t.offset) : null,
      },
    });
  }

  // ===== Aluno 2 — Corrida =====
  const treinosA2 = [
    { offset: -8, status: 'CONCLUIDO', mod: 'CORRIDA', titulo: 'Recuperação 5k',
      detalhes: { tipo: 'corrida', distanciaKm: 5, ritmoAlvoMinKm: '6:00', realizado: { distanciaKm: 5.02, tempoMin: 30.5, fcMedia: 142 } } },
    { offset: -6, status: 'CONCLUIDO', mod: 'CORRIDA', titulo: 'Intervalado 8x400m',
      detalhes: { tipo: 'corrida', tipoSessao: 'intervalado', tiros: '8x400m R:90s', realizado: { tempos: ['1:35','1:34','1:36','1:35','1:37','1:36','1:38','1:37'] } } },
    { offset: -4, status: 'CONCLUIDO', mod: 'CORRIDA', titulo: 'Tempo Run 8k',
      detalhes: { tipo: 'corrida', distanciaKm: 8, ritmoAlvoMinKm: '5:00', realizado: { distanciaKm: 8.01, tempoMin: 40.2, fcMedia: 168 } } },
    { offset: -2, status: 'CONCLUIDO', mod: 'CORRIDA', titulo: 'Long Run 15k',
      detalhes: { tipo: 'corrida', distanciaKm: 15, ritmoAlvoMinKm: '5:30', realizado: { distanciaKm: 15.1, tempoMin: 83, fcMedia: 158 } } },
    { offset: 0, status: 'EM_EXECUCAO', mod: 'CORRIDA', titulo: 'Fartlek 60min',
      detalhes: { tipo: 'corrida', tipoSessao: 'fartlek', duracaoMin: 60, blocos: '5x(3min forte / 2min easy)' } },
    { offset: 1, status: 'PENDENTE', mod: 'MUSCULACAO', titulo: 'Força para corredores',
      detalhes: { tipo: 'musculacao', exercicios: [
        { nome: 'Agachamento Búlgaro', prescrito: { series: 3, reps: 10 } },
        { nome: 'Stiff Unilateral', prescrito: { series: 3, reps: 12 } },
        { nome: 'Prancha', prescrito: { series: 3, tempoSeg: 60 } },
      ] } },
    { offset: 3, status: 'PENDENTE', mod: 'CORRIDA', titulo: 'Long Run 18k',
      detalhes: { tipo: 'corrida', distanciaKm: 18, ritmoAlvoMinKm: '5:30' } },
    { offset: 5, status: 'PENDENTE', mod: 'CORRIDA', titulo: 'Tiros 6x1k',
      detalhes: { tipo: 'corrida', tipoSessao: 'intervalado', tiros: '6x1000m R:2min' } },
  ];
  for (const t of treinosA2) {
    await prisma.treino.create({
      data: {
        alunoId: a2.id, professorId: prof.id, modalidade: t.mod,
        titulo: t.titulo, dataAlvo: diaRel(t.offset), status: t.status,
        detalhes: t.detalhes,
        iniciadoEm: t.status === 'EM_EXECUCAO' ? new Date() : null,
        finalizadoEm: t.status === 'CONCLUIDO' ? diaRel(t.offset) : null,
      },
    });
  }

  // ===== Aluno 3 — Triathlon =====
  const treinosA3 = [
    { offset: -10, status: 'CONCLUIDO', mod: 'NATACAO', titulo: 'Técnica 1500m',
      detalhes: { tipo: 'natacao', distanciaTotalM: 1500, series: ['400m aquecimento','10x100m crawl R:20','5x100m pernada','100m volta calma'], realizado: { tempoMin: 32 } } },
    { offset: -9, status: 'CONCLUIDO', mod: 'CICLISMO', titulo: 'Bike Z2 60km',
      detalhes: { tipo: 'ciclismo', distanciaKm: 60, zona: 'Z2', realizado: { distanciaKm: 61.2, tempoMin: 132, potenciaMediaW: 180 } } },
    { offset: -7, status: 'CONCLUIDO', mod: 'CORRIDA', titulo: 'Brick Run 5k pós bike',
      detalhes: { tipo: 'corrida', distanciaKm: 5, contexto: 'brick', realizado: { distanciaKm: 5, tempoMin: 24, fcMedia: 162 } } },
    { offset: -5, status: 'CONCLUIDO', mod: 'NATACAO', titulo: 'Resistência 2000m',
      detalhes: { tipo: 'natacao', distanciaTotalM: 2000, series: ['200m aquecimento','3x500m R:30','5x100m sprint','200m volta calma'] } },
    { offset: -3, status: 'CONCLUIDO', mod: 'CICLISMO', titulo: 'Intervalado FTP',
      detalhes: { tipo: 'ciclismo', tipoSessao: 'intervalado', blocos: '4x8min @ FTP R:4min', realizado: { potenciaMediaW: 240 } } },
    { offset: -1, status: 'CONCLUIDO', mod: 'CORRIDA', titulo: 'Long Run 16k',
      detalhes: { tipo: 'corrida', distanciaKm: 16, realizado: { distanciaKm: 16.05, tempoMin: 88, fcMedia: 156 } } },
    { offset: 0, status: 'PENDENTE', mod: 'NATACAO', titulo: 'Open Water Sim 1900m',
      detalhes: { tipo: 'natacao', distanciaTotalM: 1900, contexto: 'simula prova', series: ['400m aquecimento','1500m contínuo'] } },
    { offset: 1, status: 'PENDENTE', mod: 'CICLISMO', titulo: 'Bike Long 90km',
      detalhes: { tipo: 'ciclismo', distanciaKm: 90, zona: 'Z2-Z3' } },
    { offset: 2, status: 'PENDENTE', mod: 'CORRIDA', titulo: 'Brick Run 10k',
      detalhes: { tipo: 'corrida', distanciaKm: 10, contexto: 'brick pós bike 90k' } },
    { offset: 4, status: 'PENDENTE', mod: 'MUSCULACAO', titulo: 'Core + estabilidade',
      detalhes: { tipo: 'musculacao', exercicios: [
        { nome: 'Prancha Lateral', prescrito: { series: 3, tempoSeg: 45 } },
        { nome: 'Dead Bug', prescrito: { series: 3, reps: 12 } },
        { nome: 'Glute Bridge', prescrito: { series: 3, reps: 15 } },
      ] } },
    { offset: 6, status: 'PENDENTE', mod: 'TRIATHLON', titulo: 'Brick triplo (S+B+R)',
      detalhes: { tipo: 'triathlon', swimM: 1000, bikeKm: 40, runKm: 5 } },
  ];
  for (const t of treinosA3) {
    await prisma.treino.create({
      data: {
        alunoId: a3.id, professorId: prof.id, modalidade: t.mod,
        titulo: t.titulo, dataAlvo: diaRel(t.offset), status: t.status,
        detalhes: t.detalhes,
        finalizadoEm: t.status === 'CONCLUIDO' ? diaRel(t.offset) : null,
      },
    });
  }

  // ===== Provas =====
  const hoje = new Date();
  const futuro = (months, day) => new Date(hoje.getFullYear(), hoje.getMonth() + months, day);

  await prisma.prova.createMany({
    data: [
      { alunoId: a1.id, modalidade: 'OUTRO', nome: 'Campeonato Interno Powerlifting', data: futuro(3, 20),
        detalhes: { categoria: '83kg', metas: { agachamento: 130, supino: 100, terra: 160 } } },
      { alunoId: a2.id, modalidade: 'CORRIDA', nome: 'Meia Maratona SP', data: futuro(2, 15),
        detalhes: { distanciaKm: 21.0975, alvoTempo: '1:45:00' } },
      { alunoId: a2.id, modalidade: 'CORRIDA', nome: 'Maratona do Rio', data: futuro(5, 5),
        detalhes: { distanciaKm: 42.195, alvoTempo: '3:45:00' } },
      { alunoId: a3.id, modalidade: 'TRIATHLON', nome: 'Ironman 70.3 Floripa', data: futuro(4, 10),
        detalhes: { swimKm: 1.9, bikeKm: 90, runKm: 21.1, alvoTempo: '5:30:00' } },
      { alunoId: a3.id, modalidade: 'TRIATHLON', nome: 'Sprint Triathlon Local', data: futuro(1, 25),
        detalhes: { swimKm: 0.75, bikeKm: 20, runKm: 5 } },
    ],
  });

  // ===== Recordes Pessoais =====
  await prisma.recordePessoal.createMany({
    data: [
      { alunoId: a1.id, modalidade: 'MUSCULACAO', exercicio: 'Supino Reto', metrica: 'kg_x_reps', valor: 82, unidade: 'kg', reps: 9 },
      { alunoId: a1.id, modalidade: 'MUSCULACAO', exercicio: 'Agachamento Livre', metrica: 'kg_x_reps', valor: 105, unidade: 'kg', reps: 5 },
      { alunoId: a1.id, modalidade: 'MUSCULACAO', exercicio: 'Levantamento Terra', metrica: 'kg_x_reps', valor: 140, unidade: 'kg', reps: 3 },
      { alunoId: a2.id, modalidade: 'CORRIDA', exercicio: '5km', metrica: 'tempo', valor: 1290, unidade: 's' },
      { alunoId: a2.id, modalidade: 'CORRIDA', exercicio: '10km', metrica: 'tempo', valor: 2730, unidade: 's' },
      { alunoId: a2.id, modalidade: 'CORRIDA', exercicio: '21km', metrica: 'tempo', valor: 6420, unidade: 's' },
      { alunoId: a3.id, modalidade: 'NATACAO', exercicio: '1500m crawl', metrica: 'tempo', valor: 1620, unidade: 's' },
      { alunoId: a3.id, modalidade: 'CICLISMO', exercicio: 'FTP 20min', metrica: 'potencia', valor: 265, unidade: 'W' },
      { alunoId: a3.id, modalidade: 'CORRIDA', exercicio: '10km', metrica: 'tempo', valor: 2520, unidade: 's' },
    ],
  });

  // ===== Atividades Strava (mock) =====
  await prisma.atividadeStrava.createMany({
    data: [
      { alunoId: a2.id, stravaId: 'mock-a2-1', tipo: 'Run', nome: 'Corrida matinal',
        distanciaM: 5020, duracaoSeg: 1830, ritmoMedio: 6.08, fcMedia: 142,
        iniciadoEm: diaRel(-8), payloadRaw: { source: 'seed' } },
      { alunoId: a2.id, stravaId: 'mock-a2-2', tipo: 'Run', nome: 'Long Run domingo',
        distanciaM: 15100, duracaoSeg: 4980, ritmoMedio: 5.50, fcMedia: 158,
        iniciadoEm: diaRel(-2), payloadRaw: { source: 'seed' } },
      { alunoId: a3.id, stravaId: 'mock-a3-1', tipo: 'Ride', nome: 'Bike Z2 longão',
        distanciaM: 61200, duracaoSeg: 7920, ritmoMedio: null, fcMedia: 138,
        iniciadoEm: diaRel(-9), payloadRaw: { source: 'seed', avgPowerW: 180 } },
      { alunoId: a3.id, stravaId: 'mock-a3-2', tipo: 'Swim', nome: 'Piscina técnica',
        distanciaM: 1500, duracaoSeg: 1920, ritmoMedio: null, fcMedia: null,
        iniciadoEm: diaRel(-10), payloadRaw: { source: 'seed' } },
    ],
  });

  console.log('Seed OK.');
  console.log('Logins:');
  console.log('  PROFESSOR     professor@apex.com / admin123');
  console.log('  NUTRICIONISTA nutri@apex.com / nutri123');
  console.log('  (ADMIN admin@apex.com é gerenciado por `npm run seed:admin`)');
  console.log('  ALUNO         aluno@apex.com / aluno123  (foco: musculação)');
  console.log('  ALUNO         maria@apex.com / maria123  (foco: corrida)');
  console.log('  ALUNO         pedro@apex.com / pedro123  (foco: triathlon)');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
