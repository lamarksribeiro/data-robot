/**
 * Schema versionado para artefatos em runs/ (JSON / JSONL).
 * Evidência local fica fora do Git; promoção usa relatórios sanitizados.
 */

export const RUN_SCHEMA_VERSION = 1;

/** Campos que nunca devem ir para relatório versionado ou log compartilhado. */
const SECRET_KEY_RE =
  /^(private[_-]?key|api[_-]?secret|passphrase|secret|mnemonic|seed)$/i;
const SECRET_VALUE_RE = /0x[a-fA-F0-9]{64}|sk_[a-zA-Z0-9]+/g;

/**
 * @param {unknown} value
 * @returns {unknown}
 */
export function redactValue(value) {
  if (typeof value === 'string') {
    return value.replace(SECRET_VALUE_RE, '[REDACTED]');
  }
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEY_RE.test(k)) {
        out[k] = '[REDACTED]';
        continue;
      }
      out[k] = redactValue(v);
    }
    return out;
  }
  return value;
}

/**
 * Envelope mínimo de um run salável / promocionável.
 * @param {object} partial
 */
export function buildRunEnvelope(partial = {}) {
  return {
    schemaVersion: RUN_SCHEMA_VERSION,
    runId: partial.runId ?? null,
    kind: partial.kind ?? null,
    label: partial.label ?? null,
    environment: partial.environment ?? 'local',
    strategyId: partial.strategyId ?? null,
    strategyVersion: partial.strategyVersion ?? null,
    presetId: partial.presetId ?? null,
    startedAt: partial.startedAt ?? new Date().toISOString(),
    live: Boolean(partial.live),
    meta: partial.meta ?? {},
    payload: partial.payload ?? {},
  };
}

/**
 * Sanitiza um registro antes de versionar ou anexar a relatório.
 * @param {object} record
 */
export function sanitizeRunRecord(record) {
  const cleaned = redactValue(record);
  if (!cleaned || typeof cleaned !== 'object' || Array.isArray(cleaned)) {
    return { schemaVersion: RUN_SCHEMA_VERSION, payload: cleaned };
  }
  if (cleaned.schemaVersion == null) {
    return { schemaVersion: RUN_SCHEMA_VERSION, ...cleaned };
  }
  return cleaned;
}
