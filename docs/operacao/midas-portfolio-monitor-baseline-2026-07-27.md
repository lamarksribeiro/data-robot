# Baseline monitor portfolio $3/$6 — 2026-07-27

**Cutover BTC:** `2026-07-27T05:27:55Z` · `entry=$3 · cap=$6 · accountExposure=$24`  
**ETH/SOL/XRP:** live ARMED no mesmo commit (`ee1c280`), feeds `eth5m`/`sol5m`/`xrp5m` OK.

## Pré-cutover (histórico 26–27)

Monitor `--days 2` ainda vê o ENTER Gold de **$14,96** (ask 0,88) — esperado; fora do regime portfolio.

## Pós-cutover

```bash
node scripts/midas/monitor-portfolio-sizing.js --days 2 --since 2026-07-27T05:27:00Z
```

Critérios 48h:
- `cost_max ≤ 6.05`
- `overBudget6 = 0`
- `exposureBlocks` monitorado (BTC file-book $24; irmãs teto $6)

Reavaliar em **2026-07-29**.
