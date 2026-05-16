import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  salvarExecucaoSchema,
  getRealizadoSchemaPorTipo,
  LIMITES_EXECUCAO,
} from '../schemas/execucao.schemas.js';

describe('salvarExecucaoSchema — strict + caps anti-DoS', () => {
  it('aceita payload mínimo de musculação', () => {
    const out = salvarExecucaoSchema.parse({
      exercicios: [{ nome: 'Supino', realizado: [{ kg: 80, reps: 10 }] }],
    });
    assert.equal(out.status, 'CONCLUIDO');
    assert.equal(out.exercicios[0].realizado[0].kg, 80);
  });

  it('rejeita campo desconhecido no set (.strict — anti storage poisoning)', () => {
    assert.throws(() =>
      salvarExecucaoSchema.parse({
        exercicios: [
          { nome: 'Supino', realizado: [{ kg: 80, reps: 10, gpsLat: -23.5 }] },
        ],
      }),
    );
  });

  it('rejeita campo desconhecido no envelope', () => {
    assert.throws(() =>
      salvarExecucaoSchema.parse({
        status: 'CONCLUIDO',
        attackPayload: 'x'.repeat(10),
      }),
    );
  });

  it('rejeita mais de MAX_EXERCICIOS_POR_EXEC exercícios', () => {
    const exercicios = Array.from(
      { length: LIMITES_EXECUCAO.MAX_EXERCICIOS_POR_EXEC + 1 },
      (_, i) => ({ nome: `Ex-${i}`, realizado: [] }),
    );
    assert.throws(() => salvarExecucaoSchema.parse({ exercicios }));
  });

  it('rejeita mais de MAX_SETS_POR_EXERCICIO sets em um exercício', () => {
    const realizado = Array.from(
      { length: LIMITES_EXECUCAO.MAX_SETS_POR_EXERCICIO + 1 },
      () => ({ kg: 50, reps: 8 }),
    );
    assert.throws(() =>
      salvarExecucaoSchema.parse({
        exercicios: [{ nome: 'Supino', realizado }],
      }),
    );
  });

  it('rejeita kg absurdo (> MAX_KG)', () => {
    assert.throws(() =>
      salvarExecucaoSchema.parse({
        exercicios: [{ nome: 'Supino', realizado: [{ kg: LIMITES_EXECUCAO.MAX_KG + 1, reps: 1 }] }],
      }),
    );
  });

  it('rejeita reps absurdas (> MAX_REPS)', () => {
    assert.throws(() =>
      salvarExecucaoSchema.parse({
        exercicios: [{ nome: 'Supino', realizado: [{ kg: 10, reps: LIMITES_EXECUCAO.MAX_REPS + 1 }] }],
      }),
    );
  });
});

describe('getRealizadoSchemaPorTipo — roteamento dinâmico', () => {
  it('corrida: aceita campos válidos, descarta extras via strict reject', () => {
    const schema = getRealizadoSchemaPorTipo('corrida');
    assert.ok(schema, 'schema de corrida deve existir');
    const out = schema.parse({ distanciaKm: 5, duracaoSeg: 1800, ritmoMedioMinKm: '6:00' });
    assert.equal(out.distanciaKm, 5);
    assert.throws(() => schema.parse({ distanciaKm: 5, hackerKey: 'lol' }));
  });

  it('corrida: ritmoMedioMinKm exige formato MM:SS', () => {
    const schema = getRealizadoSchemaPorTipo('corrida');
    assert.throws(() => schema.parse({ ritmoMedioMinKm: 'foo' }));
  });

  it('ciclismo: rejeita potência absurda', () => {
    const schema = getRealizadoSchemaPorTipo('ciclismo');
    assert.throws(() => schema.parse({ potenciaMediaW: 9999 }));
  });

  it('natacao: aceita distância em metros, rejeita > 50km', () => {
    const schema = getRealizadoSchemaPorTipo('natacao');
    assert.doesNotThrow(() => schema.parse({ distanciaTotalM: 2500 }));
    assert.throws(() => schema.parse({ distanciaTotalM: 100000 }));
  });

  it('hyrox: blocos com cap', () => {
    const schema = getRealizadoSchemaPorTipo('hyrox');
    const blocos = Array.from(
      { length: LIMITES_EXECUCAO.MAX_BLOCOS_REALIZADO + 1 },
      () => ({ rounds: 1 }),
    );
    assert.throws(() => schema.parse({ blocos }));
  });

  it('hyrox: bloco rejeita campo extra', () => {
    const schema = getRealizadoSchemaPorTipo('hyrox');
    assert.throws(() => schema.parse({ blocos: [{ rounds: 1, malicious: 'x' }] }));
  });

  it('musculação NÃO tem schema dinâmico (usa exercicios[])', () => {
    assert.equal(getRealizadoSchemaPorTipo('musculacao'), null);
  });

  it('tipo desconhecido retorna null (handled no service)', () => {
    assert.equal(getRealizadoSchemaPorTipo('alquimia'), null);
  });

  it('outro: aceita string OU objeto com cap, rejeita objeto com campo extra', () => {
    const schema = getRealizadoSchemaPorTipo('outro');
    assert.doesNotThrow(() => schema.parse('Treino livre'));
    assert.doesNotThrow(() => schema.parse({ descricao: 'livre', duracaoSeg: 600 }));
    assert.throws(() => schema.parse({ descricao: 'livre', hackerKey: 1 }));
  });
});
