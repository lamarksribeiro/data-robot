# OMS P3 — ordens, executor, journal, reconciliação

Status: **código sim + live implementado** (endurecido em 2026-07-20). A validação real prolongada no Giovanna continua sendo gate operacional.

## Componentes

| Módulo | Papel |
|--------|-------|
| `src/oms/createOms.js` | Idempotência por `intentId`, estados, fills |
| `src/oms/states.js` | CREATED→…→MATCHED/CANCELED/REJECTED/UNKNOWN |
| `src/oms/journal.js` | Append-only + checkpoint |
| `src/oms/positionLedger.js` | Posição por instância + exposição agregada |
| `src/oms/reconciler.js` | UNKNOWN / duplicatas / REST snapshot / órfãs remotas |
| `src/oms/omsSink.js` | Sink da engine (dry-run/shadow/live) |
| `src/executor/transport.js` | Sim determinístico + stub fail-closed |
| `src/executor/liveTransport.js` | Place/cancel/reconcile REST + heartbeat CLOB real |
| `src/executor/userChannel.js` | Canal sim ou WS autenticado, PING/PONG e normalização order/trade |
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
| `live` | CLOB + user WS + REST | ACK no POST; PARTIAL/FILL/CANCEL só por evento/reconciliação |

## Recovery

```js
oms.checkpoint();
const entries = oms.journal.snapshot();
// restart
oms2.restoreFromJournal(entries);
// posição e ordens restauradas antes de nova intenção
```

## Gate real ainda aberto

- provar User WS + REST sem fill duplicado;
- provar heartbeat/cancel remoto durante desconexão e shutdown;
- reconciliar restart com ordem aberta, partial fill e posição existente;
- zero ordem remota sem intent/journal local.

Multi-instância / multi-mercado live na mesma conta exige OMS e journal atribuídos por `strategyInstanceId + marketId` sob coordenador global — ver [ADR-002](./adr-002-strategy-catalog-supervision.md).
