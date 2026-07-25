/**
 * Backup / rollback simples do journal (arquivo local).
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * @param {string} dir
 * @param {string} label
 * @param {number} keep
 */
function pruneTimestampedCheckpoints(dir, label, keep) {
  if (!fs.existsSync(dir)) return;
  const prefix = `checkpoint-${label}-`;
  const latestName = `${prefix}latest.json`;
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.json') && f !== latestName)
    .map((name) => {
      const filePath = path.join(dir, name);
      return { name, filePath, mtimeMs: fs.statSync(filePath).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const file of files.slice(keep)) {
    fs.unlinkSync(file.filePath);
  }
}

/**
 * @param {string} filePath
 * @param {string} payload
 */
function writeAtomic(filePath, payload) {
  const temp = `${filePath}.tmp`;
  fs.writeFileSync(temp, payload);
  fs.renameSync(temp, filePath);
}

/**
 * @param {object} [opts]
 * @param {string} [opts.dir]
 * @param {number} [opts.maxCheckpointFiles]
 */
export function createJournalBackup(opts = {}) {
  const dir = opts.dir ?? path.join('runs', 'journal-backups');
  const maxCheckpointFiles = Number(opts.maxCheckpointFiles ?? 5);

  return {
    dir,
    maxCheckpointFiles,

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
      const payload = `${JSON.stringify({ savedAt: new Date().toISOString(), checkpoint }, null, 2)}\n`;
      const ts = Date.now();

      const latestPath = path.join(dir, `checkpoint-${label}-latest.json`);
      writeAtomic(latestPath, payload);

      const rotatedPath = path.join(dir, `checkpoint-${label}-${ts}.json`);
      writeAtomic(rotatedPath, payload);

      pruneTimestampedCheckpoints(dir, label, maxCheckpointFiles);
      return latestPath;
    },

    loadCheckpoint(file) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!data.checkpoint || typeof data.checkpoint !== 'object') {
        throw new Error('checkpoint persistido inválido');
      }
      return data.checkpoint;
    },

    latestCheckpoint(label = 'engine') {
      if (!fs.existsSync(dir)) return null;

      const latestPath = path.join(dir, `checkpoint-${label}-latest.json`);
      if (fs.existsSync(latestPath)) return latestPath;

      const prefix = `checkpoint-${label}-`;
      const files = fs
        .readdirSync(dir)
        .filter((f) => f.startsWith(prefix) && f.endsWith('.json') && !f.endsWith('-latest.json'))
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
