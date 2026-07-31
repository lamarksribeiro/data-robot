/**
 * Protection lane — intents redutoras de risco não podem ser mortas pelo circuit
 * (nem por FAK miss de ENTER). Ver reports midas-por-que-a-protecao-nao-executa.
 */

/**
 * EXIT / CANCEL / REVERSE passam pela protection lane (circuit e daily-loss
 * não bloqueiam). REVERSE aqui = flatten + eventual nova entrada; negar o pai
 * impede a venda protetora.
 * @param {{ kind?: string }|null|undefined} intent
 */
export function isProtectionLaneIntent(intent) {
  const kind = intent?.kind;
  return kind === 'EXIT' || kind === 'CANCEL' || kind === 'REVERSE';
}

/**
 * Rejeições de negócio do CLOB esperadas (FAK miss, min size, …) — não são
 * falha de transporte e não devem abrir o circuit breaker.
 * @param {unknown} reason
 */
export function isExpectedClobReject(reason) {
  const r = String(reason ?? '').toLowerCase();
  if (!r) return false;
  return (
    /no orders found to match with fak/.test(r) ||
    /couldn't be fully filled|could not be fully filled/.test(r) ||
    /lower than the minimum|minimum:\s*\d/.test(r) ||
    /post-only mode/.test(r) ||
    /fak_remote_missing/.test(r) ||
    /invalid_size_or_price/.test(r) ||
    /no_token_id/.test(r) ||
    /deadline_expired/.test(r)
  );
}

/**
 * Sink/transport reject que não deve contar como falha de sistema.
 * @param {unknown} reason
 * @param {{ kind?: string }|null|undefined} [intent]
 */
export function shouldRecordTransportFailure(reason, intent = null) {
  if (isProtectionLaneIntent(intent)) return false;
  if (isExpectedClobReject(reason)) return false;
  return true;
}
