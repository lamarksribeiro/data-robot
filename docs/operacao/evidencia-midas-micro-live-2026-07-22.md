# Evidência — MIDAS micro-live (ENTER → fill → hold)

**Data:** 22/07/2026  
**Host:** Giovanna (`data-robot` UI `hntw925e58wh7y0jcal0linv`)  
**Estratégia:** `midas-carry-v1` / preset canário (`canaryMidasPreset` = `MIDAS_V1` + `MICRO_TEST`)  
**Modo:** live CLOB (`--live`, sem `--cancel`)  
**Commits relevantes:** `b7628ef` (heartbeat/rotação) → `fa9c1d8` (min notional $1, cap canário $2)

## Progresso (meta: 3 micros) — **COMPLETO**

| # | Status | Side | Qty | Fill | Notional | Evento (ET) | marketId |
|---|--------|------|-----|------|----------|-------------|----------|
| 1 | **PASS** | DOWN | 2 | 0.86 | $1.72 | 1:10–1:15PM | `btc-updown-5m-1784740200` |
| 2 | **PASS** | DOWN | 2 | 0.70 | $1.40 | 8:00–8:05PM | `btc-updown-5m-1784764800` |
| 3 | **PASS** | DOWN | ~2.41 | 0.63 | $1.52 | 8:10–8:15PM | `btc-updown-5m-1784765400` |

Gate **E2 / wave-1 enter-hold:** 3 fills reconciliados, 0 órfã.

## Micro #1

| Campo | Valor |
|-------|--------|
| `accepted` / `filled` / `reconciled` | true / true / true |
| Ask → maxPrice / fill | 0.84 → 0.86 / 0.86 |
| Timeline | ACK `clob:matched` → FILL `user_ws_trade_matched` |
| Log | `/tmp/midas-micro/live-4.log` |

## Micro #2

| Campo | Valor |
|-------|--------|
| `accepted` / `filled` / `reconciled` | true / true / true |
| Ask → maxPrice / fill | 0.68 → 0.70 / 0.70 |
| Timeline | ACK `clob:matched` → FILL `user_ws_trade_matched` |
| Log | `/tmp/midas-micro/live-6.log` |
| Rotações | 5 |

## Micro #3

| Campo | Valor |
|-------|--------|
| `accepted` / `filled` / `reconciled` | true / true / true |
| `orphan` / `parity.ok` | false / true |
| Ask → maxPrice / fill | 0.74 → 0.76 / **0.63** (melhor que o ask) |
| Qty | 2.412697 |
| Budget | $1.52 |
| Fee esperada | ≈ $0.03937 |
| Timeline | ACK `clob:matched` → FILL `rest_reconcile` |
| intentId | `midas-carry-v1:1.0.0:0:btc-updown-5m-1784765400:ENTER:1` |
| Log | `/tmp/midas-micro/live-7.log` |
| Rotações | 2 |

### Tentativas que não contam

| Run | Resultado |
|-----|-----------|
| `live-3` | REJECT notional $0.91 abaixo do min marketable $1 (pré-`fa9c1d8`) |
| `live-5` | ENTER FAK killed sem liquidez (`no orders found to match`) |

## Cap / sizing

Polymarket exige **≥$1** em BUY marketable (FAK). Canário: `maxCanaryBudget: 2` + `sizeCanaryBuy`.

## Comando

```bash
npm run midas:micro-live -- --live --timeout=1800
```

## Próximo

1. **P9** / canário contínuo + dashboard UI.
2. Subir budget só após P9.
