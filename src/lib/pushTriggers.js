import { dispatch } from '../services/push.service.js';

// PR #27 — wrapper único pros gatilhos de engajamento.
//
// Contrato:
//   firePush({ userId, payload, trigger })
//
// Garantias:
//   - **Fire-and-forget**: agendado via queueMicrotask. A função retorna
//     ANTES de chamar dispatch, então NUNCA bloqueia o response do
//     controller pai. Treinador clica "clonar", recebe 201 instantâneo,
//     push sai em background.
//   - **Erro nunca propaga**: dispatch().catch silencia. Push falhar não
//     pode causar 5xx ou rollback no fluxo principal. É colateral.
//   - **Audit trail stdout**: 1 linha estruturada por trigger (JSON) com
//     stats. Datadog/Render engolem e dão rastreabilidade sem onerar DB.
//   - **Feature flag implícita**: dispatch já lança 503 se push desabilitado.
//     O catch absorve — call sites não precisam checar env.pushEnabled.
//
// Test hook: __setDispatchForTests injeta mock pra testes integrados
// dos services dispararem o trigger sem bater push real.

let _dispatch = dispatch;
export function __setDispatchForTests(fn) { _dispatch = fn; }
export function __resetDispatchForTests() { _dispatch = dispatch; }

export function firePush({ userId, payload, trigger }) {
  if (!userId) {
    // Sem destinatário: trigger mal configurado. Loga e segue —
    // não queremos crash mas queremos saber.
    console.warn(`[push-trigger:${trigger}] userId ausente, skip`);
    return;
  }

  queueMicrotask(async () => {
    try {
      const stats = await _dispatch({ userId, payload });
      // Audit estruturado — Datadog/Loki parseia JSON. Mantém um nível só
      // (`[push-trigger]`) pra facilitar grep/filtro em produção.
      console.log(JSON.stringify({
        level: 'info',
        msg: 'push-trigger',
        trigger,
        userId,
        sent: stats.sent,
        dead: stats.dead,
        failed: stats.failed,
      }));
    } catch (err) {
      // 503 (push desabilitado) é caso comum em dev — não polui log com error.
      const level = err?.status === 503 ? 'debug' : 'warn';
      console[level === 'warn' ? 'warn' : 'log'](JSON.stringify({
        level,
        msg: 'push-trigger-failed',
        trigger,
        userId,
        error: err?.message || String(err),
      }));
    }
  });
}

// ─── Builders de payload por trigger ────────────────────────────────
// Centralizar aqui evita strings mágicas espalhadas pelos services e
// facilita ajustar copy sem garimpar grep.

export function payloadNovoPlanoAlimentar() {
  return {
    title: 'Novo Plano Alimentar 🥗',
    body: 'Seu nutricionista acabou de disponibilizar sua nova dieta.',
    url: '/aluno/perfil',
    tag: 'novo-plano-alimentar',
  };
}

export function payloadNovoTreinoPrescrito() {
  return {
    title: 'Treino na agulha! 🏋️',
    body: 'Seu treinador liberou uma nova rotina de treinos para você.',
    url: '/aluno/dashboard',
    tag: 'novo-treino',
  };
}

// PR #31 — Conquista desbloqueada (Sprint 11).
// 1 push por desbloqueio (idempotência garantida no engine via
// @@unique([alunoId, codigo])). Title destaca o tier, body explica.
export function payloadConquistaDesbloqueada(conquista) {
  const tierIcon = {
    bronze: '🥉',
    prata: '🥈',
    ouro: '🥇',
    platina: '🏆',
  }[conquista.tier] || conquista.icone || '🎖️';
  return {
    title: `${tierIcon} Conquista desbloqueada!`,
    body: `${conquista.titulo}. Toque pra ver sua estante.`,
    url: `/aluno/conquistas?destaque=${conquista.codigo}`,
    tag: `conquista-${conquista.codigo}`,
  };
}

// Anti-flood: 1 RP vs N RPs no mesmo salvarExecucao geram payloads
// diferentes. Acima de 1 agrega — único push, conteúdo claro.
export function payloadNovoRecorde(novosRecordes) {
  if (!Array.isArray(novosRecordes) || novosRecordes.length === 0) return null;

  if (novosRecordes.length === 1) {
    const rp = novosRecordes[0];
    return {
      title: 'Novo Recorde Pessoal! 🏆',
      body: `Você quebrou: ${rp.exercicio}. Toque para ver sua sala de troféus.`,
      url: '/aluno/rps',
      tag: 'rp-novo',
    };
  }

  return {
    title: `${novosRecordes.length} novos PRs! 🏆`,
    body: 'Você quebrou várias marcas neste treino. Toque para ver a sala de troféus.',
    url: '/aluno/rps',
    tag: 'rp-novo',
  };
}
