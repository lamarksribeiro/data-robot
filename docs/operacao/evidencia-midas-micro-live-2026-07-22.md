# Evidência — MIDAS micro-live #1 (ENTER → fill → hold)

**Data:** 22/07/2026  
**Host:** Giovanna (`data-robot` UI `hntw925e58wh7y0jcal0linv`)  
**Estratégia:** `midas-carry-v1` / preset canário (`canaryMidasPreset` = `MIDAS_V1` + `MICRO_TEST`)  
**Modo:** live CLOB (`--live`, sem `--cancel`)  
**Commits relevantes:** `b7628ef` (heartbeat/rotação) → `fa9c1d8` (min notional $1, cap canário $2)

## Resultado

| Campo | Valor |
|-------|--------|
| Gate E1 (1º micro) | **PASS** |
| `accepted` | `true` |
| `filled` | `true` |
| `reconciled` | `true` |
| `orphan` | `false` |
| `parity.ok` | `true` |
| Cap canário | **$2** (mín. marketable BUY Polymarket = $1) |
| Hold | posição aberta ao fim do harness (sem EXIT live) |

### Fill reconciliado

| Campo | Valor |
|-------|--------|
| Side | DOWN |
| Ask no sinal | 0.84 |
| maxPrice | 0.86 |
| Qty | **2** |
| avgFillPrice | 0.86 |
| Budget / notional | **$1.72** |
| Order type | FAK |
| Evento (ET) | Bitcoin Up or Down — July 22, **1:10PM–1:15PM** |
| marketId | `btc-updown-5m-1784740200` |
| intentId | `midas-carry-v1:1.0.0:0:btc-updown-5m-1784740200:ENTER:1` |
| Timeline | ACK `clob:matched` → FILL `user_ws_trade_matched` |
| Rotações até ENTER | 1 |
| Fee esperada (taker) | ≈ $0.01686 |

### Tentativa anterior (não conta como micro)

`live-3` (commit pré-`fa9c1d8`): ENTER gerado com notional **$0.91** → CLOB REJECT  
`invalid amount for a marketable BUY order ($0.91), min size: 1`.  
Corrigido com `sizeCanaryBuy` + `maxCanaryBudget: 2`.

## Artefatos

No container UI (ephemeral `/tmp`):

| Arquivo | Conteúdo |
|---------|----------|
| `/tmp/midas-micro/live-4.log` | log completo + report `LIVE processado` |

Consulta:

```bash
ssh Giovanna
UICID=$(docker ps | awk '/hntw925e58wh7y0jcal0linv/{print $NF; exit}')
docker exec "$UICID" sed -n '/LIVE processado/,/^}/p' /tmp/midas-micro/live-4.log
```

## Comando

```bash
npm run midas:micro-live -- --live --timeout=1800
```

## Próximo

1. Micro-live **#2** e **#3** (mesmo critério: fill reconciliado, hold, 0 órfã).
2. Depois: EXIT live + P9 / dashboard (fora deste gate enter/hold).
