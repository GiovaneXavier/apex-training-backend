import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { validarTextoCom, __internal } from '../lib/insightVeto.js';

// PR #32 — Guardião lexical pós-LLM.
//
// NOTA SOBRE FALSE POSITIVES (limitação documentada do V1):
// O matcher é substring case-insensitive — não entende negações
// semânticas. Frases como "não houve lesão" disparam o termo "lesão".
// Aceito como tradeoff de segurança no V1. Documentado em
// src/lib/insightVeto.js. Evolução futura = classificador semântico.

describe('validarTextoCom — categoria PRESCRITIVO', () => {
  it('detecta "considere reduzir"', () => {
    const r = validarTextoCom('Considere reduzir o volume semanal.');
    assert.equal(r.ok, false);
    assert.equal(r.categoria, 'PRESCRITIVO');
  });

  it('detecta "recomendo que" (caso comum de LLM)', () => {
    const r = validarTextoCom('Recomendo que você ajuste a carga.');
    assert.equal(r.ok, false);
    assert.equal(r.categoria, 'PRESCRITIVO');
  });

  it('detecta "aumente a intensidade"', () => {
    const r = validarTextoCom('Aumente a intensidade na próxima semana.');
    assert.equal(r.ok, false);
    assert.equal(r.categoria, 'PRESCRITIVO');
  });

  it('detecta "pegue mais leve" no meio do texto', () => {
    const r = validarTextoCom('Bom trabalho. Pegue mais leve amanhã.');
    assert.equal(r.ok, false);
    assert.equal(r.categoria, 'PRESCRITIVO');
  });
});

describe('validarTextoCom — categoria MEDICO', () => {
  it('detecta "lesão"', () => {
    const r = validarTextoCom('Cuidado com lesão muscular.');
    assert.equal(r.ok, false);
    assert.equal(r.categoria, 'MEDICO');
  });

  it('detecta "sono ruim"', () => {
    const r = validarTextoCom('Seu sono ruim afetou a recuperação.');
    assert.equal(r.ok, false);
    assert.equal(r.categoria, 'MEDICO');
  });

  it('detecta "hidratação"', () => {
    const r = validarTextoCom('Atenção à hidratação durante o treino.');
    assert.equal(r.ok, false);
    assert.equal(r.categoria, 'MEDICO');
  });

  it('detecta "overtraining"', () => {
    const r = validarTextoCom('Sinais de overtraining detectados.');
    assert.equal(r.ok, false);
  });

  it('FALSE POSITIVE documentado: "não houve lesão" também dispara veto (tradeoff V1)', () => {
    // Aceito como tradeoff. Cai no fallback estático — UX continua ok.
    const r = validarTextoCom('Excelente semana — não houve lesão e o volume foi entregue.');
    assert.equal(r.ok, false);
    assert.equal(r.categoria, 'MEDICO');
  });
});

describe('validarTextoCom — categoria PREDITIVO', () => {
  it('detecta "você vai bater"', () => {
    const r = validarTextoCom('Você vai bater seu RP em algumas semanas.');
    assert.equal(r.ok, false);
    assert.equal(r.categoria, 'PREDITIVO');
  });

  it('detecta "estimativa de pace"', () => {
    const r = validarTextoCom('Baseado nisso, estimativa de pace para 5k é 4:50.');
    assert.equal(r.ok, false);
    assert.equal(r.categoria, 'PREDITIVO');
  });

  it('detecta "tendência indica que"', () => {
    const r = validarTextoCom('A tendência indica que sua performance vai subir.');
    assert.equal(r.ok, false);
    assert.equal(r.categoria, 'PREDITIVO');
  });
});

describe('validarTextoCom — textos LIMPOS passam', () => {
  it('insight retroativo factual passa', () => {
    const r = validarTextoCom(
      'Você fechou 4 semanas seguidas com 14 treinos concluídos. RPE médio caiu de 8 para 7.2.',
    );
    assert.equal(r.ok, true);
  });

  it('destaque de marco passa', () => {
    const r = validarTextoCom(
      'Você fechou 4 semanas consecutivas.',
      'Primeiro RP de musculação desbloqueado.',
      'Atividade em 14 dias diferentes.',
    );
    assert.equal(r.ok, true);
  });

  it('input vazio passa', () => {
    const r = validarTextoCom();
    assert.equal(r.ok, true);
  });

  it('input null/undefined passa', () => {
    const r = validarTextoCom(null, undefined, '');
    assert.equal(r.ok, true);
  });
});

describe('validarTextoCom — múltiplos textos compostos', () => {
  it('avalia summary + destaques em conjunto (veto em qualquer um falha)', () => {
    const r = validarTextoCom(
      'Excelente semana de treino.',          // limpo
      'Primeiro RP desbloqueado.',            // limpo
      'Recomendo que aumente o volume.',      // veto
    );
    assert.equal(r.ok, false);
    assert.equal(r.categoria, 'PRESCRITIVO');
  });
});

describe('Catálogo VETOS estrutura', () => {
  it('cobre as 3 categorias declaradas', () => {
    const cats = Object.keys(__internal.VETOS);
    assert.deepEqual(cats.sort(), ['MEDICO', 'PREDITIVO', 'PRESCRITIVO']);
  });

  it('cada categoria tem pelo menos 5 termos curados', () => {
    for (const [cat, lista] of Object.entries(__internal.VETOS)) {
      assert.ok(lista.length >= 5, `${cat} deve ter ≥5 termos`);
    }
  });
});
