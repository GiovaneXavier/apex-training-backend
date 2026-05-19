// PR #32 — Guardião lexical pós-LLM (Sprint 12 / Aluno Intelligence).
//
// CAMADA 3 da defesa em profundidade:
//   1. System prompt em "coleira curta" (LLM-side).
//   2. Anthropic input_schema + Zod (estrutural).
//   3. Filtro lexical aqui (semântico bruto).
//   4. Fallback estático em código (rede de segurança final).
//
// PROPÓSITO: pegar texto prescritivo, médico ou preditivo que escape do
// prompt. LLMs escorregam em instruções negativas em cenários de borda.
// Filtro determinístico = porteiro previsível.
//
// LIMITAÇÃO CONHECIDA (documentada propositalmente):
//   Match é por substring case-insensitive. NÃO entende contexto
//   semântico. Frases como "O relatório NÃO aponta nenhuma lesão" ou
//   "Nada de fadiga acumulada" disparam falso positivo no termo "lesão"
//   / "fadiga". Aceito como tradeoff:
//   - Garante segurança absoluta no V1.
//   - Frequência baixa em produção (system prompt já vetou esses tópicos).
//   - Quando falso positivo dispara, cai no fallback estático → UX ok.
//   Evolução futura (V2): classificador semântico fino (NLP) ou modelo
//   secundário pra revisar. Não cabe neste PR.

// Lista curada por categoria. Termos exatos, case-insensitive.
// Cada categoria reflete uma proibição do system prompt.

const VETOS = Object.freeze({
  PRESCRITIVO: [
    'considere reduzir', 'considere aumentar',
    'considere descansar', 'considere diminuir',
    'recomendo que', 'sugiro que', 'aconselho',
    'pegue mais leve', 'pegue mais pesado',
    'pegar mais leve', 'pegar mais pesado',
    'aumente a carga', 'diminua a carga',
    'aumente o volume', 'diminua o volume',
    'reduza a intensidade', 'aumente a intensidade',
  ],
  MEDICO: [
    'lesão', 'lesionar', 'machucado',
    'dor muscular', 'dor articular',
    'sono ruim', 'qualidade do sono',
    'hidratação', 'hidrate-se',
    'suplemento', 'suplementação',
    'overtraining',
    'recuperação muscular',
  ],
  PREDITIVO: [
    'você vai bater', 'previsão de',
    'estimativa de pace', 'estimativa de tempo',
    'projeção de', 'tendência indica que',
    'em x semanas você',
    'no próximo treino você vai',
  ],
});

const VETOS_FLAT = Object.freeze(
  Object.entries(VETOS).flatMap(([cat, lista]) =>
    lista.map((termo) => ({ termo: termo.toLowerCase(), categoria: cat })),
  ),
);

/**
 * Valida que TODOS os textos estão livres de termos veto.
 *
 * @param  {...string} textos — qualquer número de strings (summary, destaques).
 * @returns {{ok: true} | {ok: false, vetoBatido: string, categoria: string}}
 */
export function validarTextoCom(...textos) {
  const corpus = textos
    .filter((t) => typeof t === 'string')
    .join(' \n ')
    .toLowerCase();
  if (corpus.length === 0) return { ok: true };

  for (const { termo, categoria } of VETOS_FLAT) {
    if (corpus.includes(termo)) {
      return { ok: false, vetoBatido: termo, categoria };
    }
  }
  return { ok: true };
}

// Exports pra testes.
export const __internal = { VETOS, VETOS_FLAT };
