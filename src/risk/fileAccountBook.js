/**
 * Livro de exposição compartilhado via arquivo (multi-container / multi-ativo).
 * Usa rename atômico + retries leves. Fallback in-memory se o dir não existir.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createAccountRiskBook } from './accountBook.js';

function sleepSync(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* spin */
  }
}

/**
 * @param {object} [opts]
 * @param {string} [opts.file] path do JSON compartilhado
 * @param {number} [opts.maxAccountExposure]
 */
export function createFileAccountRiskBook(opts = {}) {
  const maxExposure = Number(opts.maxAccountExposure) > 0 ? Number(opts.maxAccountExposure) : 24;
  const file = opts.file
    ? path.resolve(opts.file)
    : path.resolve(process.env.ENGINE_ACCOUNT_BOOK_FILE || 'runs/shared/account-risk-book.json');
  const lockFile = `${file}.lock`;
  const memory = createAccountRiskBook({ maxAccountExposure: maxExposure });

  function ensureDir() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  function readDisk() {
    try {
      if (!fs.existsSync(file)) return null;
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  }

  function writeDisk(snap) {
    ensureDir();
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...snap, savedAtMs: Date.now() }, null, 2));
    fs.renameSync(tmp, file);
  }

  function withLock(fn) {
    ensureDir();
    let acquired = false;
    for (let i = 0; i < 40; i += 1) {
      try {
        const fd = fs.openSync(lockFile, 'wx');
        fs.closeSync(fd);
        acquired = true;
        break;
      } catch {
        sleepSync(25 + Math.floor(Math.random() * 25));
      }
    }
    if (!acquired) {
      // Contenção: opera só em memória desta instância (fail-open local).
      return fn(false);
    }
    try {
      const disk = readDisk();
      if (disk) memory.restore(disk);
      const result = fn(true);
      writeDisk(memory.snapshot());
      return result;
    } finally {
      try {
        fs.unlinkSync(lockFile);
      } catch {
        /* ignore */
      }
    }
  }

  // bootstrap
  try {
    ensureDir();
    const disk = readDisk();
    if (disk) memory.restore(disk);
    else writeDisk(memory.snapshot());
  } catch {
    /* volume indisponível — memória pura */
  }

  return {
    get maxAccountExposure() {
      return memory.maxAccountExposure;
    },
    getExposure(instanceId) {
      return withLock(() => memory.getExposure(instanceId));
    },
    totalExposure() {
      return withLock(() => memory.totalExposure());
    },
    wouldExceed(notional) {
      return withLock(() => memory.wouldExceed(notional));
    },
    tryReserve(instanceId, notional) {
      return withLock(() => memory.tryReserve(instanceId, notional));
    },
    release(instanceId, notional) {
      return withLock(() => memory.release(instanceId, notional));
    },
    set(instanceId, notional) {
      return withLock(() => memory.set(instanceId, notional));
    },
    snapshot() {
      return withLock(() => memory.snapshot());
    },
    restore(snap) {
      return withLock(() => {
        memory.restore(snap);
        return memory.snapshot();
      });
    },
    file,
  };
}
