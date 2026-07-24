/**
 * Biblioteca operacional de estratégias (data-robot).
 * Mais simples que o data-backtest: escolher família → versão/preset → editar → salvar → ativar.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { TFC_V7, TFC_RUNTIME_KEYS } from '../tfc/preset-v7.js';
import {
  MIDAS_V1,
  MIDAS_ROBUST_V1,
  MIDAS_AGGRESSIVE_V1,
  MIDAS_RUNTIME_KEYS,
  MICRO_AGGRESSIVE,
  canaryMidasPreset,
} from '../tfc/preset-midas.js';

/** Params do runtime MIDAS (inclui sigma/scoop/early-warn/danger cont./equity scale). Sem walletSize. */
const EDITABLE_MIDAS = [...MIDAS_RUNTIME_KEYS];
const EDITABLE_TFC = [...TFC_RUNTIME_KEYS];
const EDITABLE_APEX = [
  'edgeEnabled',
  'edgeWindowStart',
  'edgeWindowEnd',
  'edgeMinDistanceAbs',
  'edgeMinAsk',
  'edgeMaxAsk',
  'edgeMinEdge',
  'edgeMinDirectionalProb',
  'edgeMaxSpread',
  'edgeMinLiquidityRatio',
  'edgeBudgetFactor',
  'useObiInScore',
  'obiScoreWeight',
  'terminalEnabled',
  'terminalMinSecondsLeft',
  'terminalMaxSecondsLeft',
  'terminalMaxDistAbs',
  'terminalMinAsk',
  'terminalMaxAsk',
  'terminalMinObi',
  'terminalMaxAdverseSpotChange',
  'reverseEnabled',
  'reverseMaxAttempts',
  'dangerExitEnabled',
  'dangerExitK',
  'dangerExitFloorSec',
  'profitLockEnabled',
];

export const PARAM_META = Object.freeze({
  midas: { runtimeKeys: MIDAS_RUNTIME_KEYS },
  tfc: { runtimeKeys: TFC_RUNTIME_KEYS },
  apex: { runtimeKeys: EDITABLE_APEX },
});

function nowIso() {
  return new Date().toISOString();
}

function slugify(value) {
  return String(value || 'custom')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
}

/** Catálogo embutido — espelha labs do data-backtest + presets do robot. */
export function builtInLibrary() {
  return {
    schemaVersion: 1,
    updatedAt: nowIso(),
    families: [
      {
        familyId: 'midas',
        label: 'MIDAS Carry',
        description: 'Carry terminal com envelope high-ask e tier de budget.',
        pluginId: 'midas-carry-v1',
        runnable: true,
        marketScope: ['btc-updown-5m'],
        versions: [
          {
            version: '1.0.0',
            label: 'V1 runtime',
            presets: [
              {
                presetId: 'btc-champion-v1',
                name: 'Champion (tier 1.5×)',
                role: 'champion',
                source: 'runtime',
                params: { ...MIDAS_V1 },
                editableKeys: EDITABLE_MIDAS,
              },
              {
                presetId: 'btc-robust-v1',
                name: 'Robust (dist 30)',
                role: 'candidate',
                source: 'runtime',
                params: { ...MIDAS_ROBUST_V1 },
                editableKeys: EDITABLE_MIDAS,
              },
              {
                presetId: 'btc-aggressive-v1',
                name: 'Aggressive (tier 2.0×)',
                role: 'candidate',
                source: 'runtime',
                params: { ...MIDAS_AGGRESSIVE_V1 },
                editableKeys: EDITABLE_MIDAS,
              },
              {
                presetId: 'btc-micro-aggressive-v1',
                name: 'Micro canário ($2–$4)',
                role: 'canary',
                source: 'runtime',
                params: { ...canaryMidasPreset() },
                editableKeys: EDITABLE_MIDAS,
              },
              {
                presetId: 'btc-micro-robust-v1',
                name: 'Micro robust',
                role: 'canary',
                source: 'runtime',
                params: { ...MIDAS_ROBUST_V1, ...MICRO_AGGRESSIVE, maxEntryBudget: 3 },
                editableKeys: EDITABLE_MIDAS,
              },
            ],
          },
        ],
      },
      {
        familyId: 'tfc',
        label: 'TFC Terminal Favorite Carry',
        description: 'Núcleo TFC V7 Danger Floor (campeão clássico).',
        pluginId: 'tfc-v7',
        runnable: true,
        marketScope: ['btc-updown-5m'],
        versions: [
          {
            version: '1.0.0',
            label: 'V7 runtime',
            presets: [
              {
                presetId: 'btc-champion-v7',
                name: 'Champion V7 Danger Floor',
                role: 'champion',
                source: 'runtime',
                params: { ...TFC_V7 },
                editableKeys: EDITABLE_TFC,
              },
              {
                presetId: 'btc-champion-v7-tight',
                name: 'V7 tight (dist 15)',
                role: 'variant',
                source: 'runtime',
                params: { ...TFC_V7, maxDistAbs: 15 },
                editableKeys: EDITABLE_TFC,
              },
              {
                presetId: 'btc-champion-v7-wide',
                name: 'V7 wide (dist 30 / ask 0.90)',
                role: 'variant',
                source: 'runtime',
                params: { ...TFC_V7, maxDistAbs: 30, maxAsk: 0.9 },
                editableKeys: EDITABLE_TFC,
              },
            ],
          },
        ],
      },
      {
        familyId: 'apex',
        label: 'APEX Triad',
        description:
          'Edge + terminal. Plugin ainda não está no runtime da engine — biblioteca para preparar versão futura.',
        pluginId: 'apex-triad-v1',
        runnable: false,
        marketScope: ['btc-updown-5m'],
        versions: [
          {
            version: '1.0.0',
            label: 'V1 candidate',
            presets: [
              {
                presetId: 'btc-candidate-v1',
                name: 'BTC Candidate V1',
                role: 'candidate',
                source: 'catalog',
                params: {
                  edgeEnabled: true,
                  edgeWindowStart: 105,
                  edgeWindowEnd: 31,
                  edgeMinDistanceAbs: 40,
                  edgeMinAsk: 0.08,
                  edgeMaxAsk: 0.65,
                  edgeMinEdge: 0.04,
                  edgeMinDirectionalProb: 0.54,
                  edgeMaxSpread: 0.06,
                  edgeMinLiquidityRatio: 0.7,
                  edgeBudgetFactor: 0.75,
                  useObiInScore: true,
                  obiScoreWeight: 0.35,
                  terminalEnabled: true,
                  terminalMinSecondsLeft: 5,
                  terminalMaxSecondsLeft: 30,
                  terminalMaxDistAbs: 20,
                  terminalMinAsk: 0.55,
                  terminalMaxAsk: 0.82,
                  terminalMinObi: 0,
                  terminalMaxAdverseSpotChange: 8,
                  reverseEnabled: true,
                  reverseMaxAttempts: 1,
                  dangerExitEnabled: true,
                  dangerExitK: 0.3,
                  dangerExitFloorSec: 4,
                  profitLockEnabled: false,
                },
                editableKeys: EDITABLE_APEX,
              },
            ],
          },
          {
            version: '2.0.0',
            label: 'V2 candidate',
            presets: [
              {
                presetId: 'btc-candidate-v2',
                name: 'BTC Candidate V2',
                role: 'candidate',
                source: 'catalog',
                params: {
                  edgeEnabled: true,
                  edgeWindowStart: 100,
                  edgeWindowEnd: 28,
                  edgeMinDistanceAbs: 35,
                  edgeMinAsk: 0.1,
                  edgeMaxAsk: 0.62,
                  edgeMinEdge: 0.035,
                  edgeBudgetFactor: 0.7,
                  terminalEnabled: true,
                  terminalMinSecondsLeft: 5,
                  terminalMaxSecondsLeft: 30,
                  terminalMaxDistAbs: 22,
                  terminalMinAsk: 0.55,
                  terminalMaxAsk: 0.85,
                  reverseEnabled: true,
                  reverseMaxAttempts: 1,
                  dangerExitEnabled: true,
                  dangerExitK: 0.3,
                  dangerExitFloorSec: 4,
                },
                editableKeys: EDITABLE_APEX,
              },
            ],
          },
        ],
      },
    ],
  };
}

export function createStrategyLibrary(opts = {}) {
  const rootDir = path.resolve(opts.rootDir ?? 'config');
  const customDir = path.resolve(opts.customDir ?? path.join(rootDir, 'custom-presets'));
  const activeFile = path.resolve(opts.activeFile ?? path.join(rootDir, 'active-strategy.json'));

  function ensureDirs() {
    fs.mkdirSync(customDir, { recursive: true });
  }

  function listCustomPresets() {
    ensureDirs();
    if (!fs.existsSync(customDir)) return [];
    const out = [];
    for (const family of fs.readdirSync(customDir, { withFileTypes: true })) {
      if (!family.isDirectory()) continue;
      const dir = path.join(customDir, family.name);
      for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith('.json')) continue;
        try {
          const raw = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
          out.push({ ...raw, familyId: raw.familyId || family.name, custom: true });
        } catch {
          /* skip corrupt */
        }
      }
    }
    return out;
  }

  function mergeLibrary() {
    const base = builtInLibrary();
    const customs = listCustomPresets();
    for (const custom of customs) {
      let family = base.families.find((f) => f.familyId === custom.familyId);
      if (!family) {
        family = {
          familyId: custom.familyId,
          label: custom.familyLabel || custom.familyId,
          description: 'Preset customizado',
          pluginId: custom.pluginId,
          runnable: custom.runnable === true,
          marketScope: custom.marketScope || ['btc-updown-5m'],
          versions: [],
        };
        base.families.push(family);
      }
      let version = family.versions.find((v) => v.version === custom.version);
      if (!version) {
        version = { version: custom.version, label: custom.versionLabel || custom.version, presets: [] };
        family.versions.push(version);
      }
      const idx = version.presets.findIndex((p) => p.presetId === custom.presetId);
      const entry = {
        presetId: custom.presetId,
        name: custom.name,
        role: custom.role || 'custom',
        source: 'custom',
        custom: true,
        createdAt: custom.createdAt,
        parentPresetId: custom.parentPresetId ?? null,
        params: custom.params || {},
        editableKeys: custom.editableKeys || Object.keys(custom.params || {}),
      };
      if (idx >= 0) version.presets[idx] = entry;
      else version.presets.push(entry);
    }
    base.updatedAt = nowIso();
    base.customCount = customs.length;
    return base;
  }

  function findPreset(library, query) {
    for (const family of library.families) {
      if (query.familyId && family.familyId !== query.familyId) continue;
      if (query.pluginId && family.pluginId !== query.pluginId) continue;
      for (const version of family.versions) {
        if (query.version && version.version !== query.version) continue;
        for (const preset of version.presets) {
          if (preset.presetId === query.presetId) {
            return { family, version, preset };
          }
        }
      }
    }
    return null;
  }

  function loadActive() {
    if (!fs.existsSync(activeFile)) return null;
    try {
      return JSON.parse(fs.readFileSync(activeFile, 'utf8'));
    } catch {
      return null;
    }
  }

  function saveActive(active) {
    ensureDirs();
    const payload = {
      ...active,
      updatedAt: nowIso(),
    };
    const temp = `${activeFile}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, activeFile);
    return payload;
  }

  function saveCustomPreset(input) {
    ensureDirs();
    const library = mergeLibrary();
    const family =
      library.families.find((f) => f.familyId === input.familyId) ||
      library.families.find((f) => f.pluginId === input.pluginId);
    if (!family) throw new Error('FAMILY_NOT_FOUND');

    const parent = findPreset(library, {
      familyId: family.familyId,
      version: input.baseVersion || family.versions[0]?.version,
      presetId: input.parentPresetId || family.versions[0]?.presets[0]?.presetId,
    });
    const baseParams = { ...(parent?.preset?.params || {}) };
    const params = { ...baseParams, ...(input.params || {}) };
    // walletSize é só lab/simulação — runtime usa accountEquityUsd real
    delete params.walletSize;
    const version = input.version || parent?.version?.version || '1.0.0-custom';
    const name = String(input.name || 'Custom').trim().slice(0, 80);
    const presetId =
      input.presetId ||
      `${slugify(name)}-${crypto.randomBytes(3).toString('hex')}`;

    const record = {
      familyId: family.familyId,
      familyLabel: family.label,
      pluginId: family.pluginId,
      runnable: family.runnable === true,
      marketScope: family.marketScope,
      version,
      versionLabel: input.versionLabel || `Custom ${version}`,
      presetId,
      name,
      role: 'custom',
      parentPresetId: parent?.preset?.presetId ?? null,
      params,
      editableKeys: parent?.preset?.editableKeys || Object.keys(params),
      createdAt: nowIso(),
      notes: input.notes || null,
    };

    const dir = path.join(customDir, family.familyId);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${presetId}.json`);
    fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    return record;
  }

  function activate(input) {
    const library = mergeLibrary();
    const hit = findPreset(library, {
      familyId: input.familyId,
      pluginId: input.pluginId,
      version: input.version,
      presetId: input.presetId,
    });
    if (!hit) throw new Error('PRESET_NOT_FOUND');
    const params = { ...hit.preset.params, ...(input.params || {}) };
    delete params.walletSize;
    if (hit.family.runnable !== true && input.force !== true) {
      const err = new Error('PLUGIN_NOT_RUNNABLE');
      err.detail = {
        pluginId: hit.family.pluginId,
        message: 'APEX ainda não está no runtime da engine; salve o preset e aguarde o plugin.',
      };
      throw err;
    }
    const active = saveActive({
      familyId: hit.family.familyId,
      pluginId: hit.family.pluginId,
      version: hit.version.version,
      presetId: hit.preset.presetId,
      name: hit.preset.name,
      params,
      marketScope: hit.family.marketScope?.[0] || 'btc-updown-5m',
      runnable: hit.family.runnable === true,
      source: hit.preset.source || 'library',
    });
    return {
      active,
      restartRequired: true,
      message: 'Estratégia marcada como ativa. Reinicie a Engine para aplicar.',
    };
  }

  return {
    rootDir,
    customDir,
    activeFile,
    list: mergeLibrary,
    loadActive,
    saveActive,
    saveCustomPreset,
    activate,
    findPreset: (query) => findPreset(mergeLibrary(), query),
  };
}
