// Utilitários de data compartilhados (PR #14, audit 4.18).
//
// Antes deste módulo: 3 implementações de `inicioSemana` espalhadas
// (desempenho.service, professor.service, frontend WeeklyTimeline) — e
// uma delas (professor.service) usava DOMINGO como início, causando
// inconsistência no dashboard ("pendentesSemana" sumia das contas de
// domingo). Centralizar elimina drift entre serviços e replica o
// contrato esperado pelo frontend (lib/dates.ts).
//
// Padrão BR: a semana começa na SEGUNDA. Hora local (não UTC) — para
// agregados de dashboard relativos à percepção do atleta. Para queries
// time-series que cruzam timezones, use `inicioSemanaUTC` em
// desempenho.service.js (mantido lá por ser um detalhe daquele cálculo).

/** Início da semana corrente (segunda 00:00:00 — hora local). */
export function inicioSemana(d = new Date()) {
  const date = new Date(d);
  date.setHours(0, 0, 0, 0);
  const dow = date.getDay();              // 0=dom..6=sab
  const diffParaSegunda = (dow + 6) % 7;  // dom→6, seg→0, ter→1...
  date.setDate(date.getDate() - diffParaSegunda);
  return date;
}

/** Próxima segunda 00:00:00 (exclusiva — use com `lt` em filtros). */
export function fimSemana(d = new Date()) {
  const ini = inicioSemana(d);
  const fim = new Date(ini);
  fim.setDate(fim.getDate() + 7);
  return fim;
}
