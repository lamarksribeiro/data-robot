# MIDAS Portfolio — 5 ativos ($2.5/$4)

Sizing live para banca ~$150: **BTC + ETH + SOL + XRP + DOGE**.

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

## ETH / SOL / XRP / DOGE (engines irmãs)

Cada ativo precisa de um processo engine com:

| Env | ETH | SOL | XRP | DOGE |
|---|---|---|---|---|
| `ENGINE_SNAPSHOT_SOURCE` | `eth5m` | `sol5m` | `xrp5m` | `doge5m` |
| `ENGINE_START_ARMED` | 0 | 0 | 0 | 0 |
| `ENGINE_STRATEGY_INSTANCE_ID` | `midas-carry-v1_eth5m_primary` | `…_sol5m_…` | `…_xrp5m_…` | `midas-carry-v1_doge5m_primary` |
| `ENGINE_PORT` | 3202 | 3203 | 3204 | 3205 |
| active-strategy | `portfolio/eth.json` → copiar p/ active | idem | idem | idem (`portfolio/doge.json`) |

Mesmos secrets Polymarket + `ENGINE_OPS_TOKEN`. **Mesmo volume** `runs/` para o account book compartilhado.

Templates gerados em `runs/strategy-config/portfolio/{eth,sol,xrp,doge}.json`.

## Coolify (Giovanna) — apps provisionadas 2026-07-27

| Ativo | App Coolify | UUID | Porta | Source | Volume `runs/` | Network alias |
|---|---|---|---:|---|---|---|
| BTC | `data-robot-engine` | `rx06uazamupj1w98pvl2b1d9` | 3201 | `btc5m` | obrigatório | `data-robot-engine` |
| ETH | `data-robot-engine-eth` | `ir7qwkhr091qey8vtjcmx46n` | 3202 | `eth5m` | obrigatório | `data-robot-engine-eth` |
| SOL | `data-robot-engine-sol` | `anaej3bcg2wtssydhsuergpz` | 3203 | `sol5m` | obrigatório | `data-robot-engine-sol` |
| XRP | `data-robot-engine-xrp` | `jcjwzh9f3flg529u642cplir` | 3204 | `xrp5m` | obrigatório | `data-robot-engine-xrp` |
| DOGE | `data-robot-engine-doge` | `hkw605v51syexmgyl6exs0pl` | 3205 | `doge5m` | obrigatório | `data-robot-engine-doge` |

**Crítico no Coolify (não omitir ao provisionar engine nova):**

1. **Persistent storage** montado em `/usr/src/app/runs` — sem isso, redeploy apaga audit/trades/checkpoints e o painel zera P&L/ordens daquele ativo.
2. **Custom network alias** igual ao hostname do `ENGINE_REGISTRY` do dashboard — sem isso o painel marca a engine offline.

BTC usa `ENGINE_MAX_ACCOUNT_EXPOSURE=16` + file book. ETH/SOL/XRP/DOGE usam teto **$4** por instância (`ENGINE_SHARE_ACCOUNT_BOOK=0`) até haver volume compartilhado.

## Monitor (48h)

```bash
node scripts/midas/monitor-portfolio-sizing.js --days 2
```

Critério: `cost_max ≤ 4.05`, `overBudget4 = 0`, acompanhar `exposureBlocks`.
