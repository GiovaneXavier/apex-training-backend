import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  getRealizadoSchemaPorTipo,
  LIMITES_EXECUCAO,
} from '../schemas/execucao.schemas.js';
import { detalhesJiuJitsu, treinoDetalhes } from '../schemas/treino.schemas.js';

// PR #23 — schema de execução BJJ (Diário de Tatame) + prescrição.

describe('treino.detalhesJiuJitsu — prescrição BJJ', () => {
  it('aceita prescrição mínima (só tipo)', () => {
    assert.doesNotThrow(() => detalhesJiuJitsu.parse({ tipo: 'jiu_jitsu' }));
  });

  it('aceita prescrição completa com aquecimento + drills + rolas', () => {
    const out = detalhesJiuJitsu.parse({
      tipo: 'jiu_jitsu',
      aquecimento: [{ nome: 'Camelo', duracaoSeg: 120 }],
      drills: [
        { movimento: 'Passagem toreando', reps: 20 },
        { movimento: 'Arm-lock da guarda', duracaoSeg: 180 },
      ],
      rolas: { rounds: 5, tempoRoundSeg: 300, descansoSeg: 60 },
      observacao: 'Foco em passagem e finalização',
    });
    assert.equal(out.drills.length, 2);
    assert.equal(out.rolas.rounds, 5);
  });

  it('rejeita prescrição sem tipo', () => {
    assert.throws(() => detalhesJiuJitsu.parse({}));
  });

  it('rolas: tempoRoundSeg > 1800 (30min) rejeita', () => {
    assert.throws(() =>
      detalhesJiuJitsu.parse({
        tipo: 'jiu_jitsu',
        rolas: { rounds: 3, tempoRoundSeg: 3600 },
      }),
    );
  });

  it('drills > 20 rejeita (anti DoS)', () => {
    const drills = Array.from({ length: 21 }, (_, i) => ({
      movimento: `Drill ${i}`,
      reps: 10,
    }));
    assert.throws(() =>
      detalhesJiuJitsu.parse({ tipo: 'jiu_jitsu', drills }),
    );
  });

  it('discriminated union (treinoDetalhes) reconhece jiu_jitsu', () => {
    const out = treinoDetalhes.parse({ tipo: 'jiu_jitsu', rolas: { rounds: 4, tempoRoundSeg: 300 } });
    assert.equal(out.tipo, 'jiu_jitsu');
  });
});

describe('jiuJitsuRealizadoSchema — Diário de Tatame (PR #23)', () => {
  // O schema vive como interno do execucao.schemas — só acessível via
  // getRealizadoSchemaPorTipo('jiu_jitsu'). É o roteador estrito que
  // o service usa após carregar o treino.
  const schema = getRealizadoSchemaPorTipo('jiu_jitsu');

  it('router devolve schema pra "jiu_jitsu"', () => {
    assert.ok(schema, 'schema deve existir');
  });

  it('aceita payload vazio (atleta só fechou sem preencher)', () => {
    assert.doesNotThrow(() => schema.parse({}));
  });

  it('aceita payload completo realista', () => {
    const out = schema.parse({
      matTimeSegundos: 5400,
      roundsCompletos: 6,
      finalizacoesFeitas: 2,
      finalizacoesSofridas: 1,
      readinessRating: 7,
      observacao: 'Joelho esquerdo travado no final.',
    });
    assert.equal(out.matTimeSegundos, 5400);
    assert.equal(out.readinessRating, 7);
  });

  it('readinessRating fora de [1,10] rejeita', () => {
    assert.throws(() => schema.parse({ readinessRating: 0 }));
    assert.throws(() => schema.parse({ readinessRating: 11 }));
    assert.throws(() => schema.parse({ readinessRating: 7.5 })); // não-inteiro
  });

  it('matTimeSegundos > 4h rejeita (cap anti-abuso)', () => {
    assert.throws(() =>
      schema.parse({ matTimeSegundos: LIMITES_EXECUCAO.MAX_MAT_TIME_SEG + 1 }),
    );
  });

  it('matTimeSegundos exato no cap aceita', () => {
    assert.doesNotThrow(() =>
      schema.parse({ matTimeSegundos: LIMITES_EXECUCAO.MAX_MAT_TIME_SEG }),
    );
  });

  it('roundsCompletos cap em 50', () => {
    assert.doesNotThrow(() =>
      schema.parse({ roundsCompletos: LIMITES_EXECUCAO.MAX_ROUNDS_JIU_JITSU }),
    );
    assert.throws(() =>
      schema.parse({ roundsCompletos: LIMITES_EXECUCAO.MAX_ROUNDS_JIU_JITSU + 1 }),
    );
  });

  it('finalizacoes Feitas/Sofridas cap em 50', () => {
    assert.throws(() => schema.parse({ finalizacoesFeitas: 51 }));
    assert.throws(() => schema.parse({ finalizacoesSofridas: 51 }));
  });

  it('valores negativos rejeitam', () => {
    assert.throws(() => schema.parse({ matTimeSegundos: -1 }));
    assert.throws(() => schema.parse({ roundsCompletos: -3 }));
    assert.throws(() => schema.parse({ finalizacoesFeitas: -1 }));
  });

  it('observacao > 500 chars rejeita', () => {
    assert.throws(() => schema.parse({ observacao: 'a'.repeat(501) }));
  });

  it('campo desconhecido rejeitado (.strict — anti storage poisoning)', () => {
    assert.throws(() => schema.parse({ matTimeSegundos: 1800, freeText: 'lol' }));
  });

  it('decimais em campos inteiros rejeitam', () => {
    assert.throws(() => schema.parse({ matTimeSegundos: 1800.5 }));
    assert.throws(() => schema.parse({ roundsCompletos: 4.2 }));
  });
});

describe('validarPorModalidade — routing JIU_JITSU end-to-end', () => {
  // Pra cobrir o caminho service → schema, integramos via
  // getRealizadoSchemaPorTipo. O routing real vive em
  // execucao.service.validarPorModalidade e usa esse roteador.
  it('payload válido sobrevive ao parse', () => {
    const out = getRealizadoSchemaPorTipo('jiu_jitsu').parse({
      matTimeSegundos: 3600,
      roundsCompletos: 4,
      readinessRating: 8,
    });
    assert.equal(out.matTimeSegundos, 3600);
  });

  it('campo extra "rola_destaque" bloqueado mesmo com payload válido', () => {
    assert.throws(() =>
      getRealizadoSchemaPorTipo('jiu_jitsu').parse({
        matTimeSegundos: 3600,
        rola_destaque: 'finalizei o purple belt',
      }),
    );
  });
});
