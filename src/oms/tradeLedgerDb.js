/**
 * Ledger persistente de trades/PnL por engine (SQLite).
 * Fonte padrão das estatísticas; Polymarket fica opcional via settings.
 */

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export const PNL_MODES = Object.freeze(['engine', 'polymarket', 'hybrid']);
export const DEFAULT_PNL_MODE = 'engine';

/**
 * @param {unknown} value
 * @returns {'engine'|'polymarket'|'hybrid'}
 */
export function normalizePnlMode(value) {
  const mode = String(value || '')
    .trim()
    .toLowerCase();
  return PNL_MODES.includes(mode) ? /** @type {'engine'|'polymarket'|'hybrid'} */ (mode) : DEFAULT_PNL_MODE;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function normalizeAutoCorrect(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

/**
 * @param {object|null|undefined} trade
 */
function tradeToRow(trade) {
  if (!trade?.marketId) return null;
  const marketId = String(trade.marketId);
  const pnl = trade.pnl == null || !Number.isFinite(Number(trade.pnl)) ? null : Number(trade.pnl);
  const enginePnl =
    trade.enginePnl == null || !Number.isFinite(Number(trade.enginePnl))
      ? pnl
      : Number(trade.enginePnl);
  return {
    market_id: marketId,
    trade_id: trade.tradeId != null ? String(trade.tradeId) : marketId,
    side: trade.side != null ? String(trade.side) : null,
    entry_price:
      trade.entryPrice == null || !Number.isFinite(Number(trade.entryPrice))
        ? null
        : Number(trade.entryPrice),
    exit_price:
      trade.exitPrice == null || !Number.isFinite(Number(trade.exitPrice))
        ? null
        : Number(trade.exitPrice),
    qty: trade.qty == null || !Number.isFinite(Number(trade.qty)) ? null : Number(trade.qty),
    entry_qty:
      trade.entryQty == null || !Number.isFinite(Number(trade.entryQty))
        ? null
        : Number(trade.entryQty),
    exit_kind: trade.exitKind != null ? String(trade.exitKind) : null,
    status: trade.status != null ? String(trade.status) : 'open',
    pnl,
    engine_pnl: enginePnl,
    pnl_source: trade.pnlSource != null ? String(trade.pnlSource) : 'engine',
    winner: trade.winner != null ? String(trade.winner) : null,
    opened_at_ms:
      trade.openedAtMs == null || !Number.isFinite(Number(trade.openedAtMs))
        ? null
        : Number(trade.openedAtMs),
    closed_at_ms:
      trade.closedAtMs == null || !Number.isFinite(Number(trade.closedAtMs))
        ? null
        : Number(trade.closedAtMs),
    duration_ms:
      trade.durationMs == null || !Number.isFinite(Number(trade.durationMs))
        ? null
        : Number(trade.durationMs),
    legs_json: JSON.stringify(Array.isArray(trade.legs) ? trade.legs : []),
    polymarket_json: trade.polymarket != null ? JSON.stringify(trade.polymarket) : null,
    updated_at_ms: Date.now(),
  };
}

/**
 * @param {object} row
 */
function rowToTrade(row) {
  let legs = [];
  let polymarket = null;
  try {
    legs = row.legs_json ? JSON.parse(row.legs_json) : [];
  } catch {
    legs = [];
  }
  try {
    polymarket = row.polymarket_json ? JSON.parse(row.polymarket_json) : null;
  } catch {
    polymarket = null;
  }
  return {
    tradeId: row.trade_id ?? row.market_id,
    marketId: row.market_id,
    side: row.side,
    entryPrice: row.entry_price,
    exitPrice: row.exit_price,
    qty: row.qty,
    entryQty: row.entry_qty,
    exitKind: row.exit_kind,
    status: row.status,
    pnl: row.pnl,
    enginePnl: row.engine_pnl,
    pnlSource: row.pnl_source,
    winner: row.winner,
    openedAtMs: row.opened_at_ms,
    closedAtMs: row.closed_at_ms,
    durationMs: row.duration_ms,
    legs,
    polymarket,
  };
}

/**
 * @param {object} [opts]
 * @param {string} [opts.dbPath] — arquivo ou ':memory:'
 * @param {import('better-sqlite3').Database} [opts.db] — injeção para testes
 */
export function createTradeLedgerDb(opts = {}) {
  const requestedPath = opts.dbPath != null ? String(opts.dbPath) : ':memory:';
  const dbPath = requestedPath === ':memory:' ? ':memory:' : path.resolve(requestedPath);

  /** @type {import('better-sqlite3').Database} */
  let db;
  if (opts.db) {
    db = opts.db;
  } else if (dbPath === ':memory:') {
    db = new Database(':memory:');
  } else {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    db = new Database(dbPath);
  }

  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS trades (
      market_id TEXT PRIMARY KEY,
      trade_id TEXT NOT NULL,
      side TEXT,
      entry_price REAL,
      exit_price REAL,
      qty REAL,
      entry_qty REAL,
      exit_kind TEXT,
      status TEXT NOT NULL,
      pnl REAL,
      engine_pnl REAL,
      pnl_source TEXT NOT NULL DEFAULT 'engine',
      winner TEXT,
      opened_at_ms INTEGER,
      closed_at_ms INTEGER,
      duration_ms INTEGER,
      legs_json TEXT NOT NULL DEFAULT '[]',
      polymarket_json TEXT,
      updated_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_trades_status_closed
      ON trades(status, closed_at_ms DESC);
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const upsertStmt = db.prepare(`
    INSERT INTO trades (
      market_id, trade_id, side, entry_price, exit_price, qty, entry_qty,
      exit_kind, status, pnl, engine_pnl, pnl_source, winner,
      opened_at_ms, closed_at_ms, duration_ms, legs_json, polymarket_json, updated_at_ms
    ) VALUES (
      @market_id, @trade_id, @side, @entry_price, @exit_price, @qty, @entry_qty,
      @exit_kind, @status, @pnl, @engine_pnl, @pnl_source, @winner,
      @opened_at_ms, @closed_at_ms, @duration_ms, @legs_json, @polymarket_json, @updated_at_ms
    )
    ON CONFLICT(market_id) DO UPDATE SET
      trade_id = excluded.trade_id,
      side = COALESCE(excluded.side, trades.side),
      entry_price = COALESCE(excluded.entry_price, trades.entry_price),
      exit_price = COALESCE(excluded.exit_price, trades.exit_price),
      qty = COALESCE(excluded.qty, trades.qty),
      entry_qty = COALESCE(excluded.entry_qty, trades.entry_qty),
      exit_kind = COALESCE(excluded.exit_kind, trades.exit_kind),
      status = excluded.status,
      pnl = excluded.pnl,
      engine_pnl = COALESCE(excluded.engine_pnl, trades.engine_pnl),
      pnl_source = excluded.pnl_source,
      winner = COALESCE(excluded.winner, trades.winner),
      opened_at_ms = COALESCE(excluded.opened_at_ms, trades.opened_at_ms),
      closed_at_ms = COALESCE(excluded.closed_at_ms, trades.closed_at_ms),
      duration_ms = COALESCE(excluded.duration_ms, trades.duration_ms),
      legs_json = excluded.legs_json,
      polymarket_json = COALESCE(excluded.polymarket_json, trades.polymarket_json),
      updated_at_ms = excluded.updated_at_ms
  `);

  const getSettingStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
  const setSettingStmt = db.prepare(`
    INSERT INTO settings(key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  const countStmt = db.prepare('SELECT COUNT(*) AS n FROM trades');
  const getByMarketStmt = db.prepare('SELECT * FROM trades WHERE market_id = ?');

  function getSettings() {
    const modeRow = getSettingStmt.get('pnl_mode');
    const correctRow = getSettingStmt.get('auto_correct_polymarket');
    return {
      pnlMode: normalizePnlMode(modeRow?.value),
      autoCorrectPolymarket: normalizeAutoCorrect(correctRow?.value),
    };
  }

  /**
   * @param {{ pnlMode?: string, autoCorrectPolymarket?: boolean }} patch
   */
  function setSettings(patch = {}) {
    if (patch.pnlMode != null) {
      setSettingStmt.run('pnl_mode', normalizePnlMode(patch.pnlMode));
    }
    if (patch.autoCorrectPolymarket != null) {
      setSettingStmt.run(
        'auto_correct_polymarket',
        normalizeAutoCorrect(patch.autoCorrectPolymarket) ? 'true' : 'false',
      );
    }
    return getSettings();
  }

  /**
   * Upsert de um trade do journal. Em escrita da engine, preserva engine_pnl.
   * @param {object} trade
   * @param {{ preserveEnginePnl?: boolean }} [opts]
   */
  function upsertTrade(trade, writeOpts = {}) {
    const row = tradeToRow(trade);
    if (!row) return null;
    if (writeOpts.preserveEnginePnl !== false && row.pnl_source === 'engine') {
      row.engine_pnl = row.pnl;
    }
    upsertStmt.run(row);
    return rowToTrade(getByMarketStmt.get(row.market_id));
  }

  /**
   * @param {object[]} trades
   */
  function upsertTrades(trades = []) {
    const tx = db.transaction((rows) => {
      let n = 0;
      for (const trade of rows) {
        if (upsertTrade(trade)) n += 1;
      }
      return n;
    });
    return tx(trades);
  }

  /**
   * @param {{ limit?: number, statuses?: string[] }} [listOpts]
   */
  function listTrades(listOpts = {}) {
    const limit = Math.max(1, Math.min(5000, Number(listOpts.limit) || 1000));
    const statuses = Array.isArray(listOpts.statuses)
      ? listOpts.statuses.map(String).filter(Boolean)
      : null;
    let rows;
    if (statuses?.length) {
      const placeholders = statuses.map(() => '?').join(',');
      rows = db
        .prepare(
          `SELECT * FROM trades
           WHERE status IN (${placeholders})
           ORDER BY COALESCE(closed_at_ms, opened_at_ms, 0) DESC
           LIMIT ?`,
        )
        .all(...statuses, limit);
    } else {
      rows = db
        .prepare(
          `SELECT * FROM trades
           ORDER BY COALESCE(closed_at_ms, opened_at_ms, 0) DESC
           LIMIT ?`,
        )
        .all(limit);
    }
    return rows.map(rowToTrade);
  }

  function countTrades() {
    return Number(countStmt.get()?.n ?? 0);
  }

  function getTrade(marketId) {
    const row = getByMarketStmt.get(String(marketId || ''));
    return row ? rowToTrade(row) : null;
  }

  /**
   * Aplica cashflow Polymarket preservando engine_pnl.
   * @param {string} marketId
   * @param {object} cf — cashflow agregado
   * @param {object} [patchedTrade] — trade já reconciliado (opcional)
   */
  function applyPolymarketCorrection(marketId, cf, patchedTrade = null) {
    const existing = getTrade(marketId);
    if (!existing) return null;
    const next = patchedTrade ? { ...existing, ...patchedTrade } : { ...existing };
    if (existing.enginePnl == null && existing.pnl != null) {
      next.enginePnl = existing.pnl;
    } else {
      next.enginePnl = existing.enginePnl;
    }
    if (cf && Number.isFinite(Number(cf.pnl))) {
      next.pnl = Number(cf.pnl);
      next.polymarket = {
        buyUsd: cf.buyUsd,
        sellUsd: cf.sellUsd,
        redeemUsd: cf.redeemUsd,
        pnl: cf.pnl,
        inferredLoss: cf.inferredLoss === true,
      };
    }
    next.pnlSource = 'hybrid_corrected';
    return upsertTrade(next, { preserveEnginePnl: false });
  }

  function close() {
    db.close();
  }

  // Defaults se ainda não existirem
  if (!getSettingStmt.get('pnl_mode')) {
    setSettingStmt.run('pnl_mode', DEFAULT_PNL_MODE);
  }
  if (!getSettingStmt.get('auto_correct_polymarket')) {
    setSettingStmt.run('auto_correct_polymarket', 'false');
  }

  return {
    dbPath,
    db,
    getSettings,
    setSettings,
    upsertTrade,
    upsertTrades,
    listTrades,
    countTrades,
    getTrade,
    applyPolymarketCorrection,
    close,
  };
}
