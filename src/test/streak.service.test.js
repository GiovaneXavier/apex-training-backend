import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

// PR #31 — testes do streak.service. Foca na função pura `computeStreak`
// (cálculo) e helpers internos. Query SQL é coberta indireta via mock no
// teste de integração.

let mod;
before(async () => {
  mod = await import('../services/streak.service.js');
});

// Helper pra gerar rows fake — `semana` no formato date_trunc retorna
// Date no Postgres; aqui simulamos passando ISO date string. computeStreak
// faz o normalize.
function makeRow(isoDate, atividades) {
  return { semana: isoDate, atividades };
}

// Calcula segunda da semana corrente (UTC) — pra gerar fixtures alinhadas
// com a janela do compute.
function segundaCorrenteUTC() {
  const d = new Date();
  const dia = d.getUTCDay();
  const diff = (dia - 1 + 7) % 7;
  const seg = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  seg.setUTCDate(seg.getUTCDate() - diff);
  return seg;
}

function semanasAtras(n) {
  const seg = segundaCorrenteUTC();
  seg.setUTCDate(seg.getUTCDate() - n * 7);
  return seg.toISOString().slice(0, 10);
}

describe('computeStreak — função pura', () => {
  it('sem rows → atual=0, maximoHistorico=0', () => {
    const out = mod.computeStreak([]);
    assert.equal(out.atual, 0);
    assert.equal(out.maximoHistorico, 0);
    assert.equal(out.semanasUltimas12.length, 12);
    assert.ok(out.semanasUltimas12.every((s) => !s.valida));
  });

  it('4 semanas seguidas com 3+ atividades → streak atual 4', () => {
    const rows = [
      makeRow(semanasAtras(3), 3),
      makeRow(semanasAtras(2), 4),
      makeRow(semanasAtras(1), 3),
      makeRow(semanasAtras(0), 5),
    ];
    const out = mod.computeStreak(rows);
    assert.equal(out.atual, 4);
    assert.equal(out.maximoHistorico, 4);
  });

  it('gap quebra streak corrente, máximo histórico preserva', () => {
    const rows = [
      // run de 3 semanas há tempo atrás
      makeRow(semanasAtras(10), 3),
      makeRow(semanasAtras(9), 3),
      makeRow(semanasAtras(8), 3),
      // gap em 7
      // run de 2 semanas recente
      makeRow(semanasAtras(1), 3),
      makeRow(semanasAtras(0), 3),
    ];
    const out = mod.computeStreak(rows);
    assert.equal(out.atual, 2, 'só as 2 recentes contam pro atual');
    assert.equal(out.maximoHistorico, 3, 'maior run histórico foi 3');
  });

  it('semana com <3 atividades NÃO é válida — quebra streak', () => {
    const rows = [
      makeRow(semanasAtras(3), 3),
      makeRow(semanasAtras(2), 2), // só 2 = quebra
      makeRow(semanasAtras(1), 3),
      makeRow(semanasAtras(0), 3),
    ];
    const out = mod.computeStreak(rows);
    assert.equal(out.atual, 2);
    assert.equal(out.maximoHistorico, 2);
  });

  it('semana CORRENTE com 0 atividades + anterior válida → streak conta a partir da anterior', () => {
    // Cenário: segunda/terça de manhã, ainda não treinou esta semana,
    // mas semana passada fechou 4 atividades. Não pode punir o atleta.
    const rows = [
      makeRow(semanasAtras(3), 3),
      makeRow(semanasAtras(2), 3),
      makeRow(semanasAtras(1), 4),
      // semana 0 ausente (0 atividades)
    ];
    const out = mod.computeStreak(rows);
    assert.equal(out.atual, 3, 'streak inclui as 3 últimas válidas, ignora corrente vazia');
  });

  it('semana corrente E anterior vazias → streak zerou de fato', () => {
    const rows = [
      makeRow(semanasAtras(4), 3),
      makeRow(semanasAtras(3), 3),
      // 2, 1, 0 vazias
    ];
    const out = mod.computeStreak(rows);
    assert.equal(out.atual, 0);
    assert.equal(out.maximoHistorico, 2);
  });

  it('semanasUltimas12 vem em ordem cronológica asc com flags válida correta', () => {
    const rows = [
      makeRow(semanasAtras(2), 3),
      makeRow(semanasAtras(0), 5),
    ];
    const out = mod.computeStreak(rows);
    assert.equal(out.semanasUltimas12.length, 12);
    // Última = corrente
    const corrente = out.semanasUltimas12[out.semanasUltimas12.length - 1];
    assert.equal(corrente.atividades, 5);
    assert.equal(corrente.valida, true);
    // -2 desde o final = índice 9
    assert.equal(out.semanasUltimas12[9].atividades, 3);
    assert.equal(out.semanasUltimas12[9].valida, true);
    // Outras = 0
    assert.equal(out.semanasUltimas12[5].atividades, 0);
    assert.equal(out.semanasUltimas12[5].valida, false);
  });

  it('atual nunca excede maximoHistorico (defesa contra inconsistência)', () => {
    const rows = [makeRow(semanasAtras(0), 3)];
    const out = mod.computeStreak(rows);
    assert.equal(out.atual, 1);
    assert.ok(out.maximoHistorico >= out.atual);
  });
});

describe('inicioSemanaUTC — alinhamento com date_trunc do Postgres', () => {
  it('domingo (UTCDay=0) cai pra segunda 6 dias antes', () => {
    const dom = new Date(Date.UTC(2026, 4, 17)); // 17 maio 2026 = domingo
    const seg = mod.__internal.inicioSemanaUTC(dom);
    assert.equal(seg.toISOString().slice(0, 10), '2026-05-11');
  });

  it('segunda (UTCDay=1) retorna ela mesma', () => {
    const seg = new Date(Date.UTC(2026, 4, 11)); // 11 maio 2026 = segunda
    const out = mod.__internal.inicioSemanaUTC(seg);
    assert.equal(out.toISOString().slice(0, 10), '2026-05-11');
  });

  it('quinta retorna segunda 3 dias antes', () => {
    const qui = new Date(Date.UTC(2026, 4, 14)); // 14 maio = quinta
    const out = mod.__internal.inicioSemanaUTC(qui);
    assert.equal(out.toISOString().slice(0, 10), '2026-05-11');
  });
});
