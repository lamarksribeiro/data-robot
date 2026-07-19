/**
 * Journal append-only do OMS — base de recovery (P3/P4).
 */

export function createJournal(opts = {}) {
  const clock = opts.clock ?? (() => Date.now());
  /** @type {object[]} */
  const entries = opts.seed ? [...opts.seed] : [];
  let seq = entries.length;

  return {
    get length() {
      return entries.length;
    },

    /**
     * @param {string} type
     * @param {object} payload
     */
    append(type, payload = {}) {
      seq += 1;
      const entry = {
        seq,
        type,
        tsMs: clock(),
        ...payload,
      };
      entries.push(entry);
      return entry;
    },

    /**
     * @param {(e: object) => boolean} [predicate]
     */
    list(predicate) {
      if (!predicate) return entries.map((e) => ({ ...e }));
      return entries.filter(predicate).map((e) => ({ ...e }));
    },

    snapshot() {
      return entries.map((e) => ({ ...e }));
    },

    /**
     * Substitui conteúdo (restore).
     * @param {object[]} next
     */
    replaceAll(next) {
      entries.length = 0;
      for (const e of next) entries.push({ ...e });
      seq = entries.reduce((max, e) => Math.max(max, e.seq ?? 0), 0);
    },
  };
}
