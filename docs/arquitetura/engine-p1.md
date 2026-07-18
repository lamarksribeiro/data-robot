# Engine P1 — kernel genérico

Status: **implementado** (2026-07-18).

## O que existe

```text
snapshot → strategy.onSnapshot → intents → risk → sink (dry-run|shadow|live-stub)
                                              ↓
                                    execution events → position + strategy.onExecutionEvent
```

- Core: `src/engine/*` (sem imports de strategy/tfc)
- Plugins fictícios: `src/strategy/fixtures/{priceCross,spreadWide}.js`
- Ligação: `src/composition/bootstrap.js`
- Conformidade: `src/strategy/conformance.js` + `npm test`

## Modos

| Mode | Sink | Posição |
|------|------|---------|
| `dry-run` | ACK sem fill | não abre |
| `shadow` | ACK + FILL simulado | atualiza |
| `live` | REJECT stub até P3 | — |

## Uso rápido

```js
import { bootstrapEngine } from './src/composition/bootstrap.js';

const engine = bootstrapEngine({
  strategyId: 'fixture-price-cross',
  mode: 'shadow',
  preset: { threshold: 50, budget: 1, maxPrice: 0.5 },
});
engine.start();
await engine.ingestSnapshot({
  marketId: 'btc-5m-1',
  nowMs: Date.now(),
  secsLeft: 20,
  btc: 100,
  priceToBeat: 99,
  book: { up: { bestBid: 0.5, bestAsk: 0.52 }, down: { bestBid: 0.48, bestAsk: 0.5 } },
  feeds: { healthy: true },
});
console.log(engine.getStatus());
```

Trocar para `fixture-spread-wide` não altera o core — só `strategyId` + preset.

## Próximo (P2)

Adapters de mercado reais, watchdogs de feed e replay determinístico alimentando o mesmo `ingestSnapshot`.
