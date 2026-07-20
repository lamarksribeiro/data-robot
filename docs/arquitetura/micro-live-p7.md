# Micro-live P7 — entrada canário via engine

Status: **harness e proteções implementados** (2026-07-20). CI sem rede/ordens reais.
**Campanha live bloqueada:** depende dos gates operacionais de User WS/recovery/Engine Ready; depois, ≥10 entradas em dias distintos.

## Pipeline

```text
feeds → snapshot → plugin tfc-v7 → risk (canary cap) → OMS → createLiveTransport → CLOB
```

Não usar `tfc:micro-entry` (legado, CLOB direto) para promoção. Preferir:

```bash
npm run tfc:micro-live                 # dry-run via engine
npm run tfc:micro-live -- --live --cancel --timeout=330
```

`--live` é obrigatório para ordem real (exit 2 sem a flag).

## Cap de canário (independente do preset $10)

| Constante | Valor | Papel |
|-----------|-------|-------|
| `MICRO_TEST.entryBudget` | $0.10 | Preferência de sizing |
| `CANARY_LIMITS.maxCanaryBudget` | $1.00 | Risk hard cap (cobre 1 share no ask V7) |
| Preset campeão `entryBudget` | $10 | **Bloqueado** em canary mode |

Reason code: `CANARY_BUDGET_EXCEEDED`.

## Módulos

| Arquivo | Papel |
|---------|-------|
| `src/executor/liveTransport.js` | CLOB place/cancel/reconcile + heartbeat (client injetável + mock) |
| `src/executor/userChannel.js` | User WS autenticado e eventos order/trade |
| `src/risk/livePreflight.js` | Checks read-only reais antes de armar live |
| `src/composition/tfcCanary.js` | `bootstrapTfcCanaryEngine` |
| `src/oms/microLiveReport.js` | Relatório fill/fee/slippage/órfã + paridade |
| `scripts/tfc/micro-live.js` | Harness dry → live |

## Relatório

`buildMicroLiveReport` exige timeline intenção → eventos → posição; marca `orphan` se ACK sem fill/cancel. O POST nunca gera fill artificial: FAK parcial/total vem de User WS ou REST.

## Gate ops (ainda aberto)

- [ ] 10 micro-entradas em dias distintos
- [ ] 100% reconciliadas, sem órfã/duplicidade/violação de cap
- [ ] Slippage/fee explicados; sem promoção só por aceite da ordem

Ver [plano P7](../plano-desenvolvimento.md).
