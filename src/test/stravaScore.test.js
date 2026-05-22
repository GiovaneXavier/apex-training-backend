import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  scoreTipo,
  scoreDistancia,
  scoreDuracao,
  scoreData,
  scoreFc,
  calcularScore,
} from '../lib/stravaScore.js';

// PR #41b — score multidimensional Strava ↔ Treino.
// Tudo aqui é pura função determinística — zero I/O, zero mocks.

describe('scoreTipo', () => {
  it('match exato Run↔CORRIDA → 1.0', () => {
    assert.equal(scoreTipo('Run', 'CORRIDA'), 1);
  });

  it('Ride↔CICLISMO → 1.0', () => {
    assert.equal(scoreTipo('Ride', 'CICLISMO'), 1);
  });

  it('Swim↔NATACAO → 1.0', () => {
    assert.equal(scoreTipo('Swim', 'NATACAO'), 1);
  });

  it('VirtualRun↔CORRIDA → 1.0 (sinônimo)', () => {
    assert.equal(scoreTipo('VirtualRun', 'CORRIDA'), 1);
  });

  it('TrailRun↔CORRIDA → 0.85 (variante)', () => {
    assert.equal(scoreTipo('TrailRun', 'CORRIDA'), 0.85);
  });

  it('Ride↔CORRIDA → 0.0 (modalidade errada)', () => {
    assert.equal(scoreTipo('Ride', 'CORRIDA'), 0);
  });

  it('WeightTraining↔MUSCULACAO → 1.0', () => {
    assert.equal(scoreTipo('WeightTraining', 'MUSCULACAO'), 1);
  });

  it('Workout↔MUSCULACAO → 0.85 (genérico)', () => {
    assert.equal(scoreTipo('Workout', 'MUSCULACAO'), 0.85);
  });

  it('tipo desconhecido → 0.0', () => {
    assert.equal(scoreTipo('AlpineSki', 'CORRIDA'), 0);
  });

  it('robusto a null/undefined → 0.0', () => {
    assert.equal(scoreTipo(null, 'CORRIDA'), 0);
    assert.equal(scoreTipo('Run', null), 0);
  });
});

describe('scoreDistancia', () => {
  it('±5% → 1.0', () => {
    assert.equal(scoreDistancia(10_500, 10_000), 1);
    assert.equal(scoreDistancia(9_500, 10_000), 1);
  });

  it('±15% (linear decay) → ~0.5', () => {
    const s = scoreDistancia(11_500, 10_000); // 15% acima
    assert.ok(s > 0.45 && s < 0.55, `esperado ~0.5, recebido ${s}`);
  });

  it('±30% → 0.0', () => {
    assert.equal(scoreDistancia(13_000, 10_000), 0);
    assert.equal(scoreDistancia(7_000, 10_000), 0);
  });

  it('prescrição ausente/zero → 0.5 (neutro)', () => {
    assert.equal(scoreDistancia(10_000, null), 0.5);
    assert.equal(scoreDistancia(10_000, 0), 0.5);
    assert.equal(scoreDistancia(10_000, undefined), 0.5);
  });

  it('atividade sem distância (musculação registrada como Run) → 0.0', () => {
    assert.equal(scoreDistancia(0, 10_000), 0);
    assert.equal(scoreDistancia(null, 10_000), 0);
  });
});

describe('scoreDuracao', () => {
  it('±10% → 1.0', () => {
    assert.equal(scoreDuracao(3_300, 3_000), 1); // 10% acima
    assert.equal(scoreDuracao(2_700, 3_000), 1); // 10% abaixo
  });

  it('±25% → ~0.5', () => {
    const s = scoreDuracao(3_750, 3_000); // 25%
    assert.ok(s > 0.45 && s < 0.55, `esperado ~0.5, recebido ${s}`);
  });

  it('±50% → 0.0', () => {
    assert.equal(scoreDuracao(4_500, 3_000), 0);
    assert.equal(scoreDuracao(1_500, 3_000), 0);
  });

  it('prescrição ausente → 0.5 (neutro)', () => {
    assert.equal(scoreDuracao(3_000, null), 0.5);
  });
});

describe('scoreData', () => {
  const ref = new Date('2026-05-20T09:00:00Z');

  it('mesmo dia (ISO YYYY-MM-DD) → 1.0', () => {
    const ativ = new Date('2026-05-20T18:00:00Z');
    assert.equal(scoreData(ativ, ref), 1);
  });

  it('±1 dia → 0.6', () => {
    const ativ = new Date('2026-05-21T09:00:00Z');
    assert.equal(scoreData(ativ, ref), 0.6);
  });

  it('±2 dias → 0.2', () => {
    const ativ = new Date('2026-05-22T09:00:00Z');
    assert.equal(scoreData(ativ, ref), 0.2);
  });

  it('±3 dias → 0.0', () => {
    const ativ = new Date('2026-05-23T09:00:00Z');
    assert.equal(scoreData(ativ, ref), 0);
  });

  it('aceita strings ISO', () => {
    assert.equal(scoreData('2026-05-20T18:00:00Z', '2026-05-20T09:00:00Z'), 1);
  });
});

describe('scoreFc', () => {
  it('FC média dentro da zona → 1.0', () => {
    assert.equal(scoreFc(155, { min: 150, max: 165 }), 1);
  });

  it('FC fora por 5bpm → 0.7', () => {
    assert.equal(scoreFc(170, { min: 150, max: 165 }), 0.7);
  });

  it('FC fora por 15bpm → 0.4', () => {
    assert.equal(scoreFc(135, { min: 150, max: 165 }), 0.4);
  });

  it('FC fora por 25bpm → 0.1', () => {
    assert.equal(scoreFc(190, { min: 150, max: 165 }), 0.1);
  });

  it('sem FC na atividade → null (peso redistribuído)', () => {
    assert.equal(scoreFc(null, { min: 150, max: 165 }), null);
    assert.equal(scoreFc(undefined, { min: 150, max: 165 }), null);
  });

  it('sem zona alvo prescrita → null', () => {
    assert.equal(scoreFc(155, null), null);
    assert.equal(scoreFc(155, {}), null);
  });
});

describe('calcularScore (composto)', () => {
  // Atividade Strava perfeita pra prescrição: 10km, 3000s, Run, mesmo dia, FC na zona.
  const ATIVIDADE_BASE = {
    tipo: 'Run',
    distanciaM: 10_000,
    duracaoSeg: 3_000,
    iniciadoEm: new Date('2026-05-20T18:00:00Z'),
    fcMedia: 155,
  };
  const TREINO_BASE = {
    modalidade: 'CORRIDA',
    dataAlvo: new Date('2026-05-20T09:00:00Z'),
    distanciaPrescritaM: 10_000,
    duracaoPrescritaSeg: 3_000,
    zonaFcAlvo: { min: 150, max: 165 },
  };

  it('match perfeito → score ≥ 0.99', () => {
    const { score, breakdown } = calcularScore(ATIVIDADE_BASE, TREINO_BASE);
    assert.ok(score >= 0.99, `esperado >=0.99, recebido ${score}`);
    assert.equal(breakdown.tipo, 1);
    assert.equal(breakdown.distancia, 1);
    assert.equal(breakdown.duracao, 1);
    assert.equal(breakdown.data, 1);
    assert.equal(breakdown.fc, 1);
  });

  it('tipo incompatível → score=0 + vetado="tipo_incompativel"', () => {
    const out = calcularScore({ ...ATIVIDADE_BASE, tipo: 'Ride' }, TREINO_BASE);
    assert.equal(out.score, 0);
    assert.equal(out.vetado, 'tipo_incompativel');
    // breakdown ainda exposto pra debug
    assert.equal(out.breakdown.tipo, 0);
  });

  it('breakdown retorna todos os eixos', () => {
    const { breakdown } = calcularScore(ATIVIDADE_BASE, TREINO_BASE);
    assert.deepEqual(
      Object.keys(breakdown).sort(),
      ['data', 'distancia', 'duracao', 'fc', 'tipo'],
    );
  });

  it('FC ausente redistribui peso — score ainda alto se outros eixos bons', () => {
    const semFc = { ...ATIVIDADE_BASE, fcMedia: null };
    const { score, breakdown } = calcularScore(semFc, TREINO_BASE);
    assert.equal(breakdown.fc, null);
    // Sem penalty: outros 4 eixos perfeitos devem dar score perfeito.
    assert.ok(score >= 0.99, `score com FC null deveria ser ~1, recebido ${score}`);
  });

  it('divergência média em distância e duração mas tipo+data ok → cai na faixa Tier 2 (0.65-0.91)', () => {
    const ativ = {
      ...ATIVIDADE_BASE,
      distanciaM: 11_500, // 15%
      duracaoSeg: 3_750,  // 25%
    };
    const { score } = calcularScore(ativ, TREINO_BASE);
    assert.ok(score >= 0.65 && score < 0.92, `esperado Tier 2 (0.65-0.91), recebido ${score}`);
  });

  it('data fora por 3 dias → score abaixo do Tier 1', () => {
    const ativ = { ...ATIVIDADE_BASE, iniciadoEm: new Date('2026-05-23T09:00:00Z') };
    const { score } = calcularScore(ativ, TREINO_BASE);
    assert.ok(score < 0.92, `data 3d fora não deveria ser Tier 1, recebido ${score}`);
  });

  it('prescrição sem distância nem duração (treino livre) → score depende de tipo+data+fc', () => {
    const treino = { ...TREINO_BASE, distanciaPrescritaM: null, duracaoPrescritaSeg: null };
    const { score } = calcularScore(ATIVIDADE_BASE, treino);
    // Tipo=1, data=1, fc=1, dist=0.5 neutro, dur=0.5 neutro → composto >= 0.7
    assert.ok(score >= 0.7 && score < 0.92, `esperado faixa Tier 2, recebido ${score}`);
  });
});
