# OMS P3 — ordens, executor, journal, reconciliação

Status: **implementado** (2026-07-18). CLOB user-WS autenticado real ainda é stub estrutural (`live-stub`).

## Componentes

| Módulo | Papel |
|--------|-------|
| `src/oms/createOms.js` | Idempotência por `intentId`, estados, fills |
| `src/oms/states.js` | CREATED→…→MATCHED/CANCELED/REJECTED/UNKNOWN |
| `src/oms/journal.js` | Append-only + checkpoint |
| `src/oms/positionLedger.js` | Posição por instância + exposição agregada |
| `src/oms/reconciler.js` | UNKNOWN / duplicatas / REST snapshot |
| `src/oms/omsSink.js` | Sink da engine (dry-run/shadow/live) |
| `src/executor/transport.js` | Sim determinístico + live-stub |
| `src/executor/userChannel.js` | Canal de usuário (sim) + heartbeat + cancel-on-disconnect |
| `src/executor/createExecutor.js` | Intent → transport → OMS |

## Contrato com a strategy

- Strategy só vê `ExecutionEvent` com `intentId`.
- `oms.getOrder()` **não** inclui `exchangeOrderId` (só `hasExchangeId`).
- Id bruto fica em `getOrderRaw` (executor/ops internos).

## Modos

| Mode | Transport | Estado final típico |
|------|-----------|---------------------|
| `dry-run` | sim `dry` (ACK+CANCEL) | CANCELED, sem posição |
| `shadow` | sim `full` / `partial` | MATCHED |
| `live` | live-stub | REJECT até CLOB real |

## Recovery

```js
oms.checkpoint();
const entries = oms.journal.snapshot();
// restart
oms2.restoreFromJournal(entries);
// posição e ordens restauradas antes de nova intenção
```
