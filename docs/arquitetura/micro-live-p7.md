# Micro-live P7 — entrada canário via engine

Status: **harness TFC e proteções genéricas implementados** (2026-07-20). CI sem rede/ordens reais.  
**Campanha live:** nenhuma estratégia aprovada.
**Trilha ágil MIDAS:** Engine Ready + shadow ≥5 + **3** micros reconciliados, concluída em 22/07.
**Promoção P9:** ≥10 micros em dias distintos + shadow 100 + soak longo. MIDAS possui composition/harness e runner long-lived.

## Pipeline (referência TFC)

```text
feeds → snapshot → plugin tfc-v7 → risk (canary cap) → OMS → createLiveTransport → CLOB
```

Não usar `tfc:micro-entry` (legado, CLOB direto) para promoção. Preferir:

```bash
npm run tfc:micro-live                 # dry-run via engine
npm run tfc:micro-live -- --live --cancel --timeout=330
```

`--live` é obrigatório para ordem real (exit 2 sem a flag). Canário futuro deve receber `strategyId`, versão, preset e `marketScope` aprovados sem bootstrap hard-coded (ver [ADR-002](./adr-002-strategy-catalog-supervision.md)).

## Cap de canário (independente do preset $10)

| Constante | Valor | Papel |
|-----------|-------|-------|
| `MICRO_TEST.entryBudget` | $0.10 | Preferência de sizing |
| `CANARY_LIMITS.maxCanaryBudget` | $2.00 | Hard cap para cumprir BUY marketable ≥$1, normalmente 2 shares |
| Preset campeão `entryBudget` | $10 | **Bloqueado** em canary mode |

Reason code: `CANARY_BUDGET_EXCEEDED`. Tier MIDAS do lab ($15/$20) **não** eleva o canário.

## Módulos

| Arquivo | Papel |
|---------|-------|
| `src/executor/liveTransport.js` | CLOB place/cancel/reconcile + heartbeat (client injetável + mock) |
| `src/executor/userChannel.js` | User WS autenticado e eventos order/trade |
| `src/risk/livePreflight.js` | Checks read-only reais antes de armar live |
| `src/composition/tfcCanary.js` | `bootstrapTfcCanaryEngine` (referência TFC) |
| `src/oms/microLiveReport.js` | Relatório fill/fee/slippage/órfã + paridade |
| `scripts/tfc/micro-live.js` | Harness dry → live |

## Relatório

`buildMicroLiveReport` exige timeline intenção → eventos → posição; marca `orphan` se ACK sem fill/cancel. O POST nunca gera fill artificial: FAK parcial/total vem de User WS ou REST.

## Gate ops

**Wave-1 (ágil):**
- [x] 3 micro-entradas MIDAS reconciliadas (hard cap $2)
- [ ] sem órfã/duplicidade/violação de cap; fee/slippage registrados

**Promoção (canário contínuo / P9):**
- [ ] 10 micro-entradas em dias distintos
- [ ] Slippage/fee explicados; sem promoção só por aceite da ordem

Ver [plano — trilha ágil](../plano-desenvolvimento.md#próximos-passos--trilha-ágil).
