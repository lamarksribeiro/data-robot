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

  for (const file of files.slice(Math.max(0, keep))) {
    try {
      fs.unlinkSync(file.filePath);
    } catch {
      /* ignore prune race */
    }
  }
}

/**
 * Mantém só os dumps manuais mais recentes (journal-*.json).
 * @param {string} dir
 * @param {number} keep
 */
function pruneJournalDumps(dir, keep) {
  if (!fs.existsSync(dir)) return;
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith('journal-') && f.endsWith('.json'))
    .map((name) => {
      const filePath = path.join(dir, name);
      return { name, filePath, mtimeMs: fs.statSync(filePath).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const file of files.slice(Math.max(0, keep))) {
    try {
      fs.unlinkSync(file.filePath);
    } catch {
      /* ignore prune race */
    }
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
 * @param {number} [opts.maxJournalFiles]
 */
export function createJournalBackup(opts = {}) {
  const dir = opts.dir ?? path.join('runs', 'journal-backups');
  const maxCheckpointFiles = Math.max(
    1,
    Number(opts.maxCheckpointFiles ?? process.env.ENGINE_CHECKPOINT_KEEP ?? 3) || 3,
  );
  const maxJournalFiles = Math.max(
    0,
    Number(opts.maxJournalFiles ?? process.env.ENGINE_JOURNAL_KEEP ?? 3) || 3,
  );

  if (fs.existsSync(dir)) {
    pruneTimestampedCheckpoints(dir, 'engine', maxCheckpointFiles);
    pruneJournalDumps(dir, maxJournalFiles);
  }

  return {
    dir,
    maxCheckpointFiles,
    maxJournalFiles,

    /**
     * @param {object[]} entries
     * @param {string} [label]
     */
    save(entries, label = 'manual') {
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `journal-${label}-${Date.now()}.json`);
      fs.writeFileSync(file, `${JSON.stringify({ savedAt: new Date().toISOString(), entries }, null, 2)}\n`);
      pruneJournalDumps(dir, maxJournalFiles);
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
      pruneJournalDumps(dir, maxJournalFiles);
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
