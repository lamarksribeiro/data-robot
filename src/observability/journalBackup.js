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

    saveCheckpoint(checkpoint, label = 'engine') {
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `checkpoint-${label}-${Date.now()}.json`);
      const temp = `${file}.tmp`;
      fs.writeFileSync(
        temp,
        `${JSON.stringify({ savedAt: new Date().toISOString(), checkpoint }, null, 2)}\n`,
      );
      fs.renameSync(temp, file);
      return file;
    },

    loadCheckpoint(file) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!data.checkpoint || typeof data.checkpoint !== 'object') {
        throw new Error('checkpoint persistido inválido');
      }
      return data.checkpoint;
    },

    latestCheckpoint() {
      if (!fs.existsSync(dir)) return null;
      const files = fs
        .readdirSync(dir)
        .filter((f) => f.startsWith('checkpoint-') && f.endsWith('.json'))
        .sort();
      return files.length ? path.join(dir, files[files.length - 1]) : null;
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
