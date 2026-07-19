/**
 * Logger estruturado JSON com redaction (sem secrets).
 */

import { redactValue } from '../runs/schema.js';

/**
 * @param {object} [opts]
 * @param {(line: string) => void} [opts.write]
 * @param {string} [opts.service]
 */
export function createLogger(opts = {}) {
  const write = opts.write ?? ((line) => process.stdout.write(`${line}\n`));
  const service = opts.service ?? 'data-robot-engine';
  let correlationId = opts.correlationId ?? null;

  function log(level, message, fields = {}) {
    const entry = redactValue({
      ts: new Date().toISOString(),
      level,
      service,
      correlationId,
      msg: message,
      ...fields,
    });
    write(JSON.stringify(entry));
    return entry;
  }

  return {
    setCorrelationId(id) {
      correlationId = id;
    },
    getCorrelationId() {
      return correlationId;
    },
    debug: (msg, fields) => log('debug', msg, fields),
    info: (msg, fields) => log('info', msg, fields),
    warn: (msg, fields) => log('warn', msg, fields),
    error: (msg, fields) => log('error', msg, fields),
  };
}
