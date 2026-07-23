# Evidência — MIDAS EXIT live (ENTER → danger_exit → flat)

**Data:** 22/07/2026  
**Host:** Giovanna (`data-robot` UI `hntw925e58wh7y0jcal0linv`)  
**Estratégia:** `midas-carry-v1` / canário + `--wait-exit` (`lateFlipReverseEnabled: false`)  
**Modo:** live CLOB  
**Commits:** `4cc74de` (harness exit-live) → `90d5082` (deploy)

## Resultado — **PASS (P8 micro)**

| Fase | Status | Detalhe |
|------|--------|---------|
| ENTER | fill | UP qty=2, accepted |
| EXIT | fill | `danger_exit` FAK, qty=2 @ 0.10 |
| Posição final | **flat** | `qty=0`, `side=null` |
| `reconciled` / `orphan` | true / false | |

### EXIT

| Campo | Valor |
|-------|--------|
| reason | `danger_exit` |
| side | UP |
| orderType | FAK |
| fillQty / avgFillPrice | 2 / 0.10 |
| bid no sinal (report) | 0.08 |
| Timeline | ACK `clob:matched` → FILL `user_ws_trade_matched` |
| intentId | `midas-carry-v1:1.0.0:0:btc-updown-5m-1784767500:EXIT:2` |
| enterIntentId | `…:ENTER:1` |
| Evento (ET) | 8:45PM–8:50PM |
| marketId | `btc-updown-5m-1784767500` |
| Rotações até ciclo | 2 |
| Log | `/tmp/midas-micro/exit-2.log` |

### Tentativa que não conta

| Run | Resultado |
|-----|-----------|
| `exit-1` | ENTER FAK killed (sem liquidez) — abortou wait-exit (qty=0) |

## Comando

```bash
npm run midas:exit-live -- --live --timeout=1800
```

## Próximo (plano)

1. P9 / canário contínuo + dashboard UI (após EXIT micro OK).
2. Subir budget só com evidência P9.
