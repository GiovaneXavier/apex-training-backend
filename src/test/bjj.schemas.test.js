import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Modalidade } from '../schemas/treino.schemas.js';
import {
  exercicioCreateSchema,
  exercicioListQuery,
} from '../schemas/exercicio.schemas.js';

// PR #22 — alinhamento Zod e shape do catálogo BJJ.

describe('Modalidade — drift HYROX corrigido + JIU_JITSU adicionado', () => {
  it('aceita HYROX (alinhamento com enum Prisma)', () => {
    assert.doesNotThrow(() => Modalidade.parse('HYROX'));
  });

  it('aceita JIU_JITSU', () => {
    assert.doesNotThrow(() => Modalidade.parse('JIU_JITSU'));
  });

  it('mantém modalidades clássicas', () => {
    for (const m of ['MUSCULACAO', 'CORRIDA', 'CICLISMO', 'NATACAO', 'TRIATHLON', 'OUTRO']) {
      assert.doesNotThrow(() => Modalidade.parse(m));
    }
  });

  it('rejeita string desconhecida', () => {
    assert.throws(() => Modalidade.parse('CROSSFIT'));
  });
});

describe('exercicioCreateSchema — campos BJJ (PR #22)', () => {
  it('aceita payload mínimo de musculação (compat retroativo)', () => {
    const out = exercicioCreateSchema.parse({ nome: 'Supino', grupoMuscular: 'PEITO' });
    // Default MUSCULACAO viaja se não passar dominio
    assert.equal(out.dominio, 'MUSCULACAO');
  });

  it('aceita payload BJJ completo', () => {
    const out = exercicioCreateSchema.parse({
      nome: 'Passagem toreando',
      dominio: 'JIU_JITSU',
      posicao: 'guarda fechada',
      tipoMovimento: 'PASSAGEM',
      videoUrl: 'https://example.com/v.mp4',
    });
    assert.equal(out.dominio, 'JIU_JITSU');
    assert.equal(out.tipoMovimento, 'PASSAGEM');
    assert.equal(out.posicao, 'guarda fechada');
  });

  it('posicao > 80 chars → rejeita (anti DoS)', () => {
    assert.throws(() =>
      exercicioCreateSchema.parse({
        nome: 'X',
        dominio: 'JIU_JITSU',
        posicao: 'a'.repeat(81),
      }),
    );
  });

  it('tipoMovimento fora do enum → rejeita', () => {
    assert.throws(() =>
      exercicioCreateSchema.parse({
        nome: 'X',
        dominio: 'JIU_JITSU',
        tipoMovimento: 'CHUTE_ALTO',
      }),
    );
  });

  it('dominio inválido → rejeita', () => {
    assert.throws(() =>
      exercicioCreateSchema.parse({ nome: 'X', dominio: 'YOGA' }),
    );
  });
});

describe('exercicioListQuery — filtros do picker', () => {
  it('default sem filtros + limit=200', () => {
    const out = exercicioListQuery.parse({});
    assert.equal(out.limit, 200);
    assert.equal(out.dominio, undefined);
    assert.equal(out.tipoMovimento, undefined);
  });

  it('aceita filtro dominio=JIU_JITSU', () => {
    const out = exercicioListQuery.parse({ dominio: 'JIU_JITSU' });
    assert.equal(out.dominio, 'JIU_JITSU');
  });

  it('aceita filtro composto dominio + tipoMovimento', () => {
    const out = exercicioListQuery.parse({
      dominio: 'JIU_JITSU',
      tipoMovimento: 'SUBMISSAO',
    });
    assert.equal(out.tipoMovimento, 'SUBMISSAO');
  });

  it('limit > 500 → rejeita', () => {
    assert.throws(() => exercicioListQuery.parse({ limit: '1000' }));
  });
});
