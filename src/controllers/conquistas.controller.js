import { prisma } from '../lib/prisma.js';
import { resolveAlunoAccess } from '../lib/access.js';
import { getStreakStats } from '../services/streak.service.js';
import { CATALOGO_CONQUISTAS } from '../data/conquistasCatalogo.js';

// PR #31 — endpoints de gamificação (Sprint 11).
//
// GET /aluno/streak              → cálculo on-the-fly.
// GET /aluno/conquistas          → catálogo enriquecido com unlocks.
// Ambas com variante /:alunoId/* pra PROFESSOR vincular ver o aluno.

export async function getStreak(req, res, next) {
  try {
    const out = await getStreakStats({
      user: req.user,
      alunoId: req.params.alunoId,
    });
    res.json(out);
  } catch (err) {
    next(err);
  }
}

// Retorna catálogo + desbloqueios. Frontend renderiza locked vs unlocked
// pelo flag `desbloqueada`. Catálogo nunca esconde locked — apenas
// substitui `descricao` por `hintLocked` no preview, decisão de UI.
export async function listConquistas(req, res, next) {
  try {
    const aluno = await resolveAlunoAccess({
      user: req.user,
      alunoId: req.params.alunoId,
    });

    const desbloqueadas = await prisma.conquistaDesbloqueada.findMany({
      where: { alunoId: aluno.id },
      select: { codigo: true, desbloqueadoEm: true, contexto: true },
      orderBy: { desbloqueadoEm: 'desc' },
    });
    const mapDesbloq = new Map(
      desbloqueadas.map((d) => [d.codigo, d]),
    );

    // Enriquece o catálogo com info de unlock por aluno. Mantém a ordem
    // do catálogo (declarativa, controlada no código).
    const itens = CATALOGO_CONQUISTAS.map((c) => {
      const d = mapDesbloq.get(c.codigo);
      return {
        codigo: c.codigo,
        titulo: c.titulo,
        descricao: c.descricao,
        hintLocked: c.hintLocked,
        tier: c.tier,
        icone: c.icone,
        desbloqueada: Boolean(d),
        desbloqueadoEm: d?.desbloqueadoEm ?? null,
      };
    });

    res.json({
      itens,
      totalDesbloqueadas: desbloqueadas.length,
      totalCatalogo: CATALOGO_CONQUISTAS.length,
    });
  } catch (err) {
    next(err);
  }
}
