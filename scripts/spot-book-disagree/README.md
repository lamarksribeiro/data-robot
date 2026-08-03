# Spot×book disagreement — dry WS

Harness **dry/shadow** do sinal SBD (spotLeader ≠ bookFavorite).

| Script | Uso |
|---|---|
| `sbd-engine.js` | Sinal + fill simulado |
| `sbd-dry.js` | Dry BTC WS (recusa `--live`) |

## Campeã

`entryMode=3` follow-spot-cheap: τ 10–40s, \|dist\|≤15, bookEdge≥0.05, spotAsk≤0.40, bookFavAsk≥0.60.

## Status de promoção

| Gate | Resultado |
|---|---|
| Sonda 100d follow-spot-cheap | holdout PF **1.25** — GO invertido |
| GLS smoke 01–07/06 | +137 PnL PF 1.14 |
| GLS holdout 01–07/07 | **−242 PnL PF 0.84** — frágil |
| follow-book (tese do plano) | NO-GO em todas as janelas |

**Dry = observação / plumbing.** Não promover a micro live sem holdout estável.

## Rodar

```powershell
# Local (latência não é verdade)
npm run sbd:dry -- --max-events=5

# Giovanna (latência real) — ver skill giovanna-dry-shadow
```

Reports: `runs/spot-book-disagree-dry/`.
