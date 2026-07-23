# Evidência — MIDAS micro-live (ENTER → fill → hold)

**Data:** 22/07/2026  
**Host:** Giovanna (`data-robot` UI `hntw925e58wh7y0jcal0linv`)  
**Estratégia:** `midas-carry-v1` / preset canário (`canaryMidasPreset` = `MIDAS_V1` + `MICRO_TEST`)  
**Modo:** live CLOB (`--live`, sem `--cancel`)  
**Commits relevantes:** `b7628ef` (heartbeat/rotação) → `fa9c1d8` (min notional $1, cap canário $2)

## Progresso (meta: 3 micros)

| # | Status | Side | Qty | Fill | Notional | Evento (ET) | marketId |
|---|--------|------|-----|------|----------|-------------|----------|
| 1 | **PASS** | DOWN | 2 | 0.86 | $1.72 | 1:10–1:15PM | `btc-updown-5m-1784740200` |
| 2 | **PASS** | DOWN | 2 | 0.70 | $1.40 | 8:00–8:05PM | `btc-updown-5m-1784764800` |
| 3 | pendente | — | — | — | — | — | — |

## Micro #1

| Campo | Valor |
|-------|--------|
| Gate E1 | **PASS** |
| `accepted` / `filled` / `reconciled` | true / true / true |
| `orphan` / `parity.ok` | false / true |
| Ask → maxPrice | 0.84 → 0.86 |
| Timeline | ACK `clob:matched` → FILL `user_ws_trade_matched` |
| intentId | `midas-carry-v1:1.0.0:0:btc-updown-5m-1784740200:ENTER:1` |
| Log | `/tmp/midas-micro/live-4.log` |
| Rotações | 1 |

## Micro #2

| Campo | Valor |
|-------|--------|
| Gate E2 (1/2) | **PASS** |
| `accepted` / `filled` / `reconciled` | true / true / true |
| `orphan` / `parity.ok` | false / true |
| Ask → maxPrice | 0.68 → 0.70 |
| Cap canário | $2 |
| Fee esperada | ≈ $0.0294 |
| Timeline | ACK `clob:matched` → FILL `user_ws_trade_matched` |
| intentId | `midas-carry-v1:1.0.0:0:btc-updown-5m-1784764800:ENTER:1` |
| Log | `/tmp/midas-micro/live-6.log` |
| Rotações | 5 |

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

Consulta:

```bash
ssh Giovanna
UICID=$(docker ps | awk '/hntw925e58wh7y0jcal0linv/{print $NF; exit}')
docker exec "$UICID" sed -n '/LIVE processado/,/^}/p' /tmp/midas-micro/live-6.log
```

## Próximo

1. Micro-live **#3** (mesmo critério) — harness `live-7` em curso.
2. Depois: EXIT live + P9 / dashboard.
