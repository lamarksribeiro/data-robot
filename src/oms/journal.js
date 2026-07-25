/**
 * Journal append-only do OMS — base de recovery (P3/P4).
 */

/**
 * Mantém só o último checkpoint OMS (restore usa apenas esse entry).
 * @param {object[]|null|undefined} entries
 * @returns {object[]|null}
 */
export function slimOmsJournalSnapshot(entries) {
  if (!entries?.length) return entries ?? null;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (entries[i]?.type === 'checkpoint') {
      return [{ ...entries[i] }];
    }
  }
  return entries.map((e) => ({ ...e }));
}

/**
 * Compacta journal em memória: último checkpoint + eventos não-checkpoint posteriores.
 * @param {object[]} entries
 * @returns {object[]}
 */
export function compactOmsJournalEntries(entries) {
  if (!entries?.length) return [];
  let lastCheckpointIdx = -1;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (entries[i]?.type === 'checkpoint') {
      lastCheckpointIdx = i;
      break;
    }
  }
  if (lastCheckpointIdx < 0) return entries.map((e) => ({ ...e }));
  return [
    { ...entries[lastCheckpointIdx] },
    ...entries.slice(lastCheckpointIdx + 1).filter((e) => e?.type !== 'checkpoint').map((e) => ({ ...e })),
  ];
}

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
