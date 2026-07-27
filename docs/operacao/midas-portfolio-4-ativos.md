# MIDAS Portfolio — 4 ativos ($2.5/$4)

Sizing live para banca ~$150: **BTC + ETH + SOL + XRP**.

| Param | Valor |
|---|---|
| `entryBudget` | $2.5 |
| `maxEntryBudget` | $4 |
| `tierAskBudgetFactor` | 1.5 (high-ask ≈ $3,75) |
| `ENGINE_MAX_ACCOUNT_EXPOSURE` | **16** (4 × $4) |
| Livro compartilhado | `runs/shared/account-risk-book.json` |

## BTC (já no Coolify `data-robot-engine`)

1. Deploy código com portfolio presets.
2. Env:
   - `ENGINE_CANARY_MAX_BUDGET=4`
   - `ENGINE_START_ARMED=0` (boot sempre DISARMED; armar manualmente quando fizer sentido)
   - `ENGINE_MAX_ACCOUNT_EXPOSURE=16`
   - `ENGINE_ACCOUNT_BOOK_FILE=runs/shared/account-risk-book.json`
   - `ENGINE_SNAPSHOT_SOURCE=btc5m`
3. Escrever `runs/strategy-config/active-strategy.json` via:

```bash
node scripts/midas/write-portfolio-active-strategy.js --asset btc --all
```

4. Restart engine. Log esperado:

`midas-live-preset btc-gold-v1 · entry=$2.5 · cap=$4 · accountExposure=$16`

## ETH / SOL / XRP (engines irmãs)

Cada ativo precisa de um processo engine com:

| Env | ETH | SOL | XRP |
|---|---|---|---|
| `ENGINE_SNAPSHOT_SOURCE` | `eth5m` | `sol5m` | `xrp5m` |
| `ENGINE_START_ARMED` | 0 | 0 | 0 |
| `ENGINE_STRATEGY_INSTANCE_ID` | `midas-carry-v1_eth5m_primary` | `…_sol5m_…` | `…_xrp5m_…` |
| `ENGINE_PORT` | 3202 | 3203 | 3204 |
| active-strategy | `portfolio/eth.json` → copiar p/ active | idem | idem |

Mesmos secrets Polymarket + `ENGINE_OPS_TOKEN`. **Mesmo volume** `runs/` para o account book compartilhado.

Templates gerados em `runs/strategy-config/portfolio/{eth,sol,xrp}.json`.

## Coolify (Giovanna) — apps provisionadas 2026-07-27

| Ativo | App Coolify | UUID | Porta | Source |
|---|---|---|---:|---|
| BTC | `data-robot-engine` | `rx06uazamupj1w98pvl2b1d9` | 3201 | `btc5m` |
| ETH | `data-robot-engine-eth` | `ir7qwkhr091qey8vtjcmx46n` | 3202 | `eth5m` |
| SOL | `data-robot-engine-sol` | `anaej3bcg2wtssydhsuergpz` | 3203 | `sol5m` |
| XRP | `data-robot-engine-xrp` | `jcjwzh9f3flg529u642cplir` | 3204 | `xrp5m` |

BTC usa `ENGINE_MAX_ACCOUNT_EXPOSURE=16` + file book. ETH/SOL/XRP usam teto **$4** por instância (`ENGINE_SHARE_ACCOUNT_BOOK=0`) até haver volume compartilhado.

## Monitor (48h)

```bash
node scripts/midas/monitor-portfolio-sizing.js --days 2
```

Critério: `cost_max ≤ 4.05`, `overBudget4 = 0`, acompanhar `exposureBlocks`.
