# TFC V7 P6 — plugin no contrato da engine

Status: **plugin TFC V7 implementado** (2026-07-19). Sem SDK/rede/ordens reais.  
Ops: shadow ≥100 eventos reais no Giovanna permanece recomendado antes da **campanha** micro-live (P7 live), não antes do harness de código. Cada plugin/preset (ex.: MIDAS) tem gate próprio — aprovação TFC não promove MIDAS ([ADR-002](./adr-002-strategy-catalog-supervision.md)).

## Plugin

| Item | Valor |
|------|-------|
| Strategy id | `tfc-v7` |
| Preset id | `btc-champion-v7` |
| Módulo | `src/strategy/tfcV7.js` |
| Avaliações puras | `src/tfc/evaluate.js` |
| Preset | `src/tfc/preset-v7.js` (`TFC_V7`) |

Capabilities: `price`, `book`. Core (`engine`/`oms`/`risk`/…) **não** importa `tfc` nem `strategy`.

## Decisões emitidas

| Intent | Quando |
|--------|--------|
| `ENTER` | Flat, feeds ok, gates V7 (5≤τ<30), ask/spread/odds/OBI/velocity |
| `REVERSE` | Posição, 4≤τ≤8, cruzamento, bid≥piso, ask oposto ≤0.95 |
| `EXIT` `late_flip_exit` | Late flip sem reverse viável |
| `EXIT` `danger_exit` | 4≤τ<5, \|signedDistance\| < 0.3×σ(5s), não reversed |
| — | τ<4 ou feed unhealthy → 0 intenções táticas |

## Uso

```js
import { bootstrapEngine } from './src/composition/bootstrap.js';
import { TFC_V7 } from './src/tfc/preset-v7.js';

const engine = bootstrapEngine({
  strategyId: 'tfc-v7',
  mode: 'shadow',
  preset: TFC_V7,
});
engine.start();
await engine.ingestSnapshot(snapshot);
```

## Gate P6 (código)

- [x] Plugin pelo contrato genérico
- [x] Conformidade + testes de limites (tempo, spread, OBI, odds, velocity, danger, floor)
- [x] Paridade sintética ≥100 casos (diferença de intenção = 0)
- [x] 0 decisão com feed stale
- [ ] Shadow ≥100 eventos reais no kernel (ops / Giovanna) — recomendado antes de P7

Ver [plano P6](../plano-desenvolvimento.md).
