/**
 * Backup / rollback simples do journal (arquivo local).
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * @param {object} [opts]
 * @param {string} [opts.dir]
 */
export function createJournalBackup(opts = {}) {
  const dir = opts.dir ?? path.join('runs', 'journal-backups');

  return {
    dir,

    /**
     * @param {object[]} entries
     * @param {string} [label]
     */
    save(entries, label = 'manual') {
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `journal-${label}-${Date.now()}.json`);
      fs.writeFileSync(file, `${JSON.stringify({ savedAt: new Date().toISOString(), entries }, null, 2)}\n`);
      return file;
    },

    /**
     * @param {string} file
     */
    load(file) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      return data.entries ?? [];
    },

    list() {
      if (!fs.existsSync(dir)) return [];
      return fs
        .readdirSync(dir)
        .filter((f) => f.startsWith('journal-') && f.endsWith('.json'))
        .map((f) => path.join(dir, f))
        .sort();
    },
  };
}
