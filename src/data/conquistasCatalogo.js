// PR #31 — Catálogo de conquistas (Sprint 11).
//
// Declarativo em código. Adicionar nova conquista = PR de código com
// review natural (testes + lint), não migration de banco. Cada entrada
// é consumida pelo conquistasEngine (avaliadores por trigger) e pelo
// endpoint /aluno/conquistas (listagem + locked preview).
//
// CAMPOS:
//   codigo      — chave estável (UPPER_SNAKE). Aparece em ConquistaDesbloqueada.codigo.
//                 NUNCA renomear; só DEPRECATE adicionando nova entrada.
//   titulo      — exibido no badge.
//   descricao   — explicação curta (mostrar quando desbloqueada).
//   hintLocked  — texto exibido quando locked. Não revela threshold exato.
//   tier        — bronze | prata | ouro | platina. Controla cor visual.
//   icone       — emoji single-char.
//   trigger     — qual evento o engine deve avaliar. Ver AVALIADORES no engine.
//   threshold   — número de comparação (semanas pra streak, etc).
//   modalidade  — opcional. Discriminador pra triggers RP_FIRST / PACE_THRESHOLD.
//   metricaPace — opcional. Pra PACE_THRESHOLD: '5k', '10k', '21k', '42k'.
//   segPorKm    — opcional. Pra PACE_THRESHOLD: pace em seg/km a bater (≤).
//   faixaAlvo   — opcional. Pra FAIXA_PROMOCAO: nome enum Faixa ou null (qualquer promoção).
//
// REGRAS:
//   - Tier visual segue ordem bronze < prata < ouro < platina.
//   - Múltiplas conquistas podem disparar do mesmo evento (ex: aluno completa
//     a 24ª semana → STREAK_2/4/12/24 todas se aplicam mas só desbloqueia as
//     que ainda não estão registradas).

export const CATALOGO_CONQUISTAS = Object.freeze([
  // ─── Streak (consistência semanal) ─────────────────────────────────
  {
    codigo: 'STREAK_2_SEMANAS',
    titulo: '2 semanas firmes',
    descricao: '2 semanas seguidas com 3+ treinos. O começo do hábito.',
    hintLocked: 'Mantenha o ritmo por algumas semanas.',
    tier: 'bronze',
    icone: '🌱',
    trigger: 'STREAK',
    threshold: 2,
  },
  {
    codigo: 'STREAK_4_SEMANAS',
    titulo: '4 semanas consecutivas',
    descricao: '1 mês completo de consistência. Você começou a virar atleta.',
    hintLocked: 'Continue treinando semana após semana.',
    tier: 'bronze',
    icone: '🥉',
    trigger: 'STREAK',
    threshold: 4,
  },
  {
    codigo: 'STREAK_12_SEMANAS',
    titulo: '12 semanas firmes',
    descricao: '3 meses sem falhar. Você venceu a inércia.',
    hintLocked: 'Consistência de meses, não semanas.',
    tier: 'prata',
    icone: '🥈',
    trigger: 'STREAK',
    threshold: 12,
  },
  {
    codigo: 'STREAK_24_SEMANAS',
    titulo: '24 semanas — meio ano',
    descricao: '6 meses consecutivos de treino. Status de veterano.',
    hintLocked: 'Meio ano de hábito.',
    tier: 'ouro',
    icone: '🥇',
    trigger: 'STREAK',
    threshold: 24,
  },
  {
    codigo: 'STREAK_52_SEMANAS',
    titulo: '1 ano inteiro',
    descricao: '52 semanas seguidas treinando. Você é outra pessoa.',
    hintLocked: 'Atletas raros chegam aqui.',
    tier: 'platina',
    icone: '🏆',
    trigger: 'STREAK',
    threshold: 52,
  },

  // ─── Recordes Pessoais — primeiros ─────────────────────────────────
  {
    codigo: 'PRIMEIRO_RP_MUSCULACAO',
    titulo: 'Primeiro recorde',
    descricao: 'Seu primeiro RP de musculação registrado.',
    hintLocked: 'Bata seu primeiro recorde pessoal.',
    tier: 'bronze',
    icone: '💪',
    trigger: 'RP_FIRST',
    modalidade: 'MUSCULACAO',
  },

  // ─── Pace — endurance ──────────────────────────────────────────────
  {
    codigo: 'RP_PACE_5K_SUB25',
    titulo: '5K sub-25',
    descricao: '5 km abaixo de 25 minutos. Velocidade de corredor.',
    hintLocked: 'Corra 5km em menos de 25 minutos.',
    tier: 'prata',
    icone: '🏃',
    trigger: 'PACE_THRESHOLD',
    metricaPace: '5k',
    segPorKm: 300,   // 25min / 5km = 300 seg/km
  },
  {
    codigo: 'RP_PACE_10K_SUB55',
    titulo: '10K sub-55',
    descricao: '10 km abaixo de 55 minutos. Você é um corredor sério.',
    hintLocked: 'Corra 10km em menos de 55 minutos.',
    tier: 'prata',
    icone: '🏃‍♂️',
    trigger: 'PACE_THRESHOLD',
    metricaPace: '10k',
    segPorKm: 330,   // 55min / 10km = 330 seg/km
  },

  // ─── BJJ — promoção de faixa ───────────────────────────────────────
  {
    codigo: 'PRIMEIRA_PROMOCAO_BJJ',
    titulo: 'Primeira promoção',
    descricao: 'Sua primeira promoção de faixa no Jiu-Jitsu.',
    hintLocked: 'Receba sua primeira promoção de faixa.',
    tier: 'prata',
    icone: '🥋',
    trigger: 'FAIXA_PROMOCAO',
    faixaAlvo: null,   // qualquer
  },
  {
    codigo: 'FAIXA_PRETA_BJJ',
    titulo: 'Faixa Preta',
    descricao: 'O grau máximo de comprometimento marcial.',
    hintLocked: 'Conquiste a faixa preta IBJJF.',
    tier: 'ouro',
    icone: '⚫',
    trigger: 'FAIXA_PROMOCAO',
    faixaAlvo: 'PRETA',
  },
]);

// Lookup helpers — evita filtrar o array inteiro em cada chamada.
const PORCODIGO = new Map(CATALOGO_CONQUISTAS.map((c) => [c.codigo, c]));
const PORTRIGGER = CATALOGO_CONQUISTAS.reduce((acc, c) => {
  if (!acc.has(c.trigger)) acc.set(c.trigger, []);
  acc.get(c.trigger).push(c);
  return acc;
}, new Map());

export function getConquistaPorCodigo(codigo) {
  return PORCODIGO.get(codigo) ?? null;
}

export function getConquistasPorTrigger(trigger) {
  return PORTRIGGER.get(trigger) ?? [];
}

export const TIERS = Object.freeze(['bronze', 'prata', 'ouro', 'platina']);
export const TRIGGERS = Object.freeze(['STREAK', 'RP_FIRST', 'PACE_THRESHOLD', 'FAIXA_PROMOCAO']);
