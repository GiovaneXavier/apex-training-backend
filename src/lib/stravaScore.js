// PR #41b — Motor de score Strava ↔ Treino (pure functions, zero I/O).
//
// Filosofia:
//   - 5 eixos: tipo, distancia, duracao, data, fc.
//   - `tipo` é GATE: se < 0.5, score = 0 (modalidade errada veta o match).
//     Razão: distância+duração semelhantes são comuns entre bike de
//     recuperação e corrida regenerativa — modalidade errada é fonte #1
//     de falso positivo em multi-sport.
//   - Pesos somam 1.0 quando todos os eixos disponíveis. Se FC ausente
//     (atleta sem fita ou treino sem zona prescrita), peso 0.10 é
//     redistribuído proporcionalmente entre os outros 4 (média harmônica
//     ponderada — não penaliza ausência de dado).
//
// Thresholds finais (decisão de produto):
//   score >= 0.92 → Tier 1 (auto-match)
//   0.65..0.91   → Tier 2 (sugestão retida)
//   < 0.65       → ignorado
// Os thresholds vivem em stravaMatch.service.js — este módulo só calcula.

// ──────────────────────────────────────────────────────────────
// 1) Eixo TIPO (modalidade ↔ activity type Strava)
// ──────────────────────────────────────────────────────────────

// Map Strava activity type → modalidade interna + confiança.
// Confiança 1.0 = sinônimo exato; 0.85 = variante semântica.
// Referência: https://developers.strava.com/docs/reference/#api-models-ActivityType
const TIPO_MAP = {
  // Corrida
  Run:        { modalidade: 'CORRIDA', conf: 1 },
  VirtualRun: { modalidade: 'CORRIDA', conf: 1 },
  TrailRun:   { modalidade: 'CORRIDA', conf: 0.85 }, // trail é corrida, mas pace/superfície divergem
  Treadmill:  { modalidade: 'CORRIDA', conf: 1 },

  // Ciclismo
  Ride:        { modalidade: 'CICLISMO', conf: 1 },
  VirtualRide: { modalidade: 'CICLISMO', conf: 1 },
  EBikeRide:   { modalidade: 'CICLISMO', conf: 0.85 }, // e-bike conta, mas perfil de esforço diferente
  GravelRide:  { modalidade: 'CICLISMO', conf: 1 },
  MountainBikeRide: { modalidade: 'CICLISMO', conf: 0.85 },

  // Natação
  Swim: { modalidade: 'NATACAO', conf: 1 },

  // Musculação
  WeightTraining: { modalidade: 'MUSCULACAO', conf: 1 },
  Workout:        { modalidade: 'MUSCULACAO', conf: 0.85 }, // "Workout" é catch-all do Strava
  Crossfit:       { modalidade: 'MUSCULACAO', conf: 0.85 },
};

export function scoreTipo(stravaTipo, modalidade) {
  if (!stravaTipo || !modalidade) return 0;
  const entry = TIPO_MAP[stravaTipo];
  if (!entry) return 0;
  if (entry.modalidade !== modalidade) return 0;
  return entry.conf;
}

// Helper exportado para o serviço — usado em brick detection.
// Retorna a modalidade interna derivada do activity type Strava
// (ou null se desconhecido). Treadmill/Run/VirtualRun → CORRIDA,
// permitindo distinguir brick real (Run + Ride no mesmo dia) de
// dois treinos da mesma modalidade (treadmill de manhã + outdoor à tarde).
export function modalidadeFromStravaType(stravaTipo) {
  if (!stravaTipo) return null;
  return TIPO_MAP[stravaTipo]?.modalidade ?? null;
}

// ──────────────────────────────────────────────────────────────
// 2) Eixo DISTANCIA (metros)
// ──────────────────────────────────────────────────────────────
// Função piecewise linear:
//   ratio = |real - alvo| / alvo
//   ratio ≤ 0.05 → 1.0  (banda perfeita)
//   ratio ≤ 0.15 → linear 1.0 → 0.5
//   ratio ≤ 0.30 → linear 0.5 → 0.0
//   ratio  > 0.30 → 0.0

export function scoreDistancia(realM, alvoM) {
  if (alvoM == null || alvoM === 0) return 0.5; // neutro (treino sem distância prescrita)
  if (realM == null || realM === 0) return 0;   // atividade sem distância — não credita
  const ratio = Math.abs(realM - alvoM) / alvoM;
  return _bandedDecay(ratio, 0.05, 0.15, 0.30);
}

// ──────────────────────────────────────────────────────────────
// 3) Eixo DURACAO (segundos)
// ──────────────────────────────────────────────────────────────
// Tolerância maior que distância (atleta pode parar no semáforo).
//   ratio ≤ 0.10 → 1.0
//   ratio ≤ 0.25 → linear 1.0 → 0.5
//   ratio ≤ 0.50 → linear 0.5 → 0.0

export function scoreDuracao(realSeg, alvoSeg) {
  if (alvoSeg == null || alvoSeg === 0) return 0.5;
  if (realSeg == null || realSeg === 0) return 0;
  const ratio = Math.abs(realSeg - alvoSeg) / alvoSeg;
  return _bandedDecay(ratio, 0.10, 0.25, 0.50);
}

// ──────────────────────────────────────────────────────────────
// 4) Eixo DATA (dia civil)
// ──────────────────────────────────────────────────────────────
// Comparação por YYYY-MM-DD UTC (atleta pode treinar 23h ou 5h —
// mesma "sessão prescrita pra esse dia").

export function scoreData(atividadeIniciadoEm, treinoDataAlvo) {
  const dAtiv = new Date(atividadeIniciadoEm);
  const dTreino = new Date(treinoDataAlvo);
  const diasDelta = Math.abs(_diasIso(dAtiv) - _diasIso(dTreino));
  if (diasDelta === 0) return 1;
  if (diasDelta === 1) return 0.6;
  if (diasDelta === 2) return 0.2;
  return 0;
}

// ──────────────────────────────────────────────────────────────
// 5) Eixo FC (frequência cardíaca média vs zona)
// ──────────────────────────────────────────────────────────────
// Retorna null quando dado ausente — score composto redistribui peso.

export function scoreFc(fcMedia, zonaAlvo) {
  if (fcMedia == null) return null;
  if (!zonaAlvo || zonaAlvo.min == null || zonaAlvo.max == null) return null;
  const { min, max } = zonaAlvo;
  if (fcMedia >= min && fcMedia <= max) return 1;
  const dist = fcMedia < min ? min - fcMedia : fcMedia - max;
  if (dist <= 10) return 0.7;
  if (dist <= 20) return 0.4;
  return 0.1;
}

// ──────────────────────────────────────────────────────────────
// COMPOSTO — pesos com redistribuição harmônica se FC ausente
// ──────────────────────────────────────────────────────────────
// Base: tipo=0.30, distancia=0.25, duracao=0.20, data=0.15, fc=0.10.
//   - Eixo `tipo` < 0.5 → veto (score=0). Modalidade errada é gate.
//   - FC null → soma de pesos válidos vira 0.90; divide cada score
//     ponderado pela soma efetiva (média ponderada honesta).

const PESOS = {
  tipo: 0.30,
  distancia: 0.25,
  duracao: 0.20,
  data: 0.15,
  fc: 0.10,
};

export function calcularScore(atividade, treino) {
  const breakdown = {
    tipo: scoreTipo(atividade.tipo, treino.modalidade),
    distancia: scoreDistancia(atividade.distanciaM, treino.distanciaPrescritaM),
    duracao: scoreDuracao(atividade.duracaoSeg, treino.duracaoPrescritaSeg),
    data: scoreData(atividade.iniciadoEm, treino.dataAlvo),
    fc: scoreFc(atividade.fcMedia, treino.zonaFcAlvo),
  };

  // Gate: tipo errado veta independente dos outros eixos.
  if (breakdown.tipo < 0.5) {
    return { score: 0, breakdown, vetado: 'tipo_incompativel' };
  }

  // Soma ponderada com redistribuição se algum eixo for null.
  let soma = 0;
  let pesoEfetivo = 0;
  for (const eixo of Object.keys(PESOS)) {
    const v = breakdown[eixo];
    if (v == null) continue; // eixo ausente — exclui da soma
    soma += v * PESOS[eixo];
    pesoEfetivo += PESOS[eixo];
  }
  // pesoEfetivo será 0.90 se FC null, 1.0 se todos presentes.
  const score = pesoEfetivo > 0 ? soma / pesoEfetivo : 0;
  return { score, breakdown };
}

// ──────────────────────────────────────────────────────────────
// Helpers internos
// ──────────────────────────────────────────────────────────────

// Decaimento por bandas piecewise linear.
// (perfeitoAte, meioAte, zeroAte) — todos em ratio (0..1).
function _bandedDecay(ratio, perfeitoAte, meioAte, zeroAte) {
  if (ratio <= perfeitoAte) return 1;
  if (ratio <= meioAte) {
    // Interpolação 1.0 → 0.5
    const span = meioAte - perfeitoAte;
    const pos = ratio - perfeitoAte;
    return 1 - 0.5 * (pos / span);
  }
  if (ratio <= zeroAte) {
    // Interpolação 0.5 → 0.0
    const span = zeroAte - meioAte;
    const pos = ratio - meioAte;
    return 0.5 - 0.5 * (pos / span);
  }
  return 0;
}

// Dia ISO em UTC como inteiro (epoch days). Permite subtração direta.
function _diasIso(date) {
  return Math.floor(date.getTime() / 86_400_000);
}
