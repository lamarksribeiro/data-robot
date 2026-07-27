#!/usr/bin/env node
/**
 * Gera active-strategy.json portfolio ($2.5/$4) para um ativo.
 * Uso:
 *   node scripts/midas/write-portfolio-active-strategy.js --asset btc
 *   node scripts/midas/write-portfolio-active-strategy.js --asset eth --out runs/strategy-config/active-strategy.eth.json
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  midasPortfolioPreset,
  describeMidasPreset,
  PORTFOLIO_MAX_ACCOUNT_EXPOSURE_USD,
} from '../../src/tfc/preset-midas.js';
import { CRYPTO_5M_ASSETS, resolveCrypto5mAsset } from '../../src/markets/crypto5m.js';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

const assetKey = arg('asset', 'btc');
const asset = resolveCrypto5mAsset(assetKey);
const preset = midasPortfolioPreset();
const described = describeMidasPreset(asset.presetId, preset);
const out =
  arg('out') ||
  path.join(
    process.env.STRATEGY_CONFIG_DIR || path.join(process.env.ENGINE_STATE_DIR || 'runs', 'strategy-config'),
    assetKey === 'btc' ? 'active-strategy.json' : `active-strategy.${assetKey}.json`,
  );

const portfolioLabel = 'Portfolio $2.5–$4 · 4 ativos · FAK/GTC';

const payload = {
  familyId: 'midas',
  pluginId: 'midas-carry-v1',
  version: '1.0.0',
  presetId: asset.presetId,
  name: `${described.displayTitle} · ${portfolioLabel}`,
  params: { ...preset },
  marketScope: asset.marketScope,
  runnable: true,
  source: 'runtime',
  updatedAt: new Date().toISOString(),
  budgetLabel: described.budgetLabel,
  displayTitle: described.displayTitle,
};

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`);
console.log(`wrote ${out}`);
console.log(
  JSON.stringify(
    {
      presetId: payload.presetId,
      entryBudget: payload.params.entryBudget,
      maxEntryBudget: payload.params.maxEntryBudget,
      tierAskBudgetFactor: payload.params.tierAskBudgetFactor,
      marketScope: payload.marketScope,
      sourceKind: asset.sourceKind,
    },
    null,
    2,
  ),
);

// Também grava templates dos 4 ativos sob portfolio/
if (process.argv.includes('--all')) {
  const dir = path.join(path.dirname(out), 'portfolio');
  fs.mkdirSync(dir, { recursive: true });
  for (const key of Object.keys(CRYPTO_5M_ASSETS)) {
    const a = CRYPTO_5M_ASSETS[key];
    const p = midasPortfolioPreset();
    const d = describeMidasPreset(a.presetId, p);
    const file = path.join(dir, `${key}.json`);
    fs.writeFileSync(
      file,
      `${JSON.stringify(
        {
          familyId: 'midas',
          pluginId: 'midas-carry-v1',
          version: '1.0.0',
          presetId: a.presetId,
          name: `${d.displayTitle} · ${portfolioLabel}`,
          params: { ...p },
          marketScope: a.marketScope,
          runnable: true,
          source: 'runtime',
          updatedAt: new Date().toISOString(),
          engineEnv: {
            ENGINE_SNAPSHOT_SOURCE: a.sourceKind,
            ENGINE_STRATEGY_INSTANCE_ID: `midas-carry-v1_${a.sourceKind}_primary`,
            ENGINE_CANARY_MAX_BUDGET: String(p.maxEntryBudget),
            ENGINE_MAX_ACCOUNT_EXPOSURE: String(PORTFOLIO_MAX_ACCOUNT_EXPOSURE_USD),
            ENGINE_ACCOUNT_BOOK_FILE: 'runs/shared/account-risk-book.json',
          },
        },
        null,
        2,
      )}\n`,
    );
    console.log(`wrote ${file}`);
  }
}
