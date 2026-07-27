# MIDAS Portfolio — 4 ativos ($3/$6)

Sizing live para banca ~$150: **BTC + ETH + SOL + XRP**.

| Param | Valor |
|---|---|
| `entryBudget` | $3 |
| `maxEntryBudget` | $6 |
| `tierAskBudgetFactor` | 1.5 (high-ask ≈ $4,50) |
| `ENGINE_MAX_ACCOUNT_EXPOSURE` | **24** (4 × $6) |
| Livro compartilhado | `runs/shared/account-risk-book.json` |

## BTC (já no Coolify `data-robot-engine`)

1. Deploy código com portfolio presets.
2. Env:
   - `ENGINE_CANARY_MAX_BUDGET=6`
   - `ENGINE_MAX_ACCOUNT_EXPOSURE=24`
   - `ENGINE_ACCOUNT_BOOK_FILE=runs/shared/account-risk-book.json`
   - `ENGINE_SNAPSHOT_SOURCE=btc5m`
3. Escrever `runs/strategy-config/active-strategy.json` via:

```bash
node scripts/midas/write-portfolio-active-strategy.js --asset btc --all
```

4. Restart engine. Log esperado:

`midas-live-preset btc-gold-v1 · entry=$3 · cap=$6 · accountExposure=$24`

## ETH / SOL / XRP (engines irmãs)

Cada ativo precisa de um processo engine com:

| Env | ETH | SOL | XRP |
|---|---|---|---|
| `ENGINE_SNAPSHOT_SOURCE` | `eth5m` | `sol5m` | `xrp5m` |
| `ENGINE_STRATEGY_INSTANCE_ID` | `midas-carry-v1_eth5m_primary` | `…_sol5m_…` | `…_xrp5m_…` |
| `ENGINE_PORT` | 3202 | 3203 | 3204 |
| active-strategy | `portfolio/eth.json` → copiar p/ active | idem | idem |

Mesmos secrets Polymarket + `ENGINE_OPS_TOKEN`. **Mesmo volume** `runs/` para o account book compartilhado.

Templates gerados em `runs/strategy-config/portfolio/{eth,sol,xrp}.json`.

## Monitor (48h)

```bash
node scripts/midas/monitor-portfolio-sizing.js --days 2
```

Critério: `cost_max ≤ 6.05`, `overBudget6 = 0`, acompanhar `exposureBlocks`.
