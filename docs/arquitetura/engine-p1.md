# Engine P1 — kernel genérico

Status: **implementado** (2026-07-18).

## O que existe

```text
snapshot → strategy.onSnapshot → intents → risk → sink (dry-run|shadow|live fail-closed)
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
| `live` | Exige sink iniciado, preflight obrigatório e composição CLOB/User WS | atualiza somente por evento reconciliado |

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

## Catálogo e instâncias

O registry pode conter vários plugins, mas o processo atual resolve uma única instância por `strategyId`. Isso já permite disponibilizar e selecionar estratégias sem alterar o core; ainda não é um supervisor multi-instância.

Evolução aprovada no [ADR-002](./adr-002-strategy-catalog-supervision.md):

1. catálogo explícito de plugins aprovados;
2. múltiplas instâncias shadow com estado/métricas isolados;
3. BTC 5m, ETH 5m e outros escopos live simultâneos somente sob OMS, account risk e recovery globais e duráveis;
4. estratégias concorrentes no mesmo mercado apenas após política de conflito/netting.

Portar ou promover uma estratégia não é requisito para o gate Engine Ready da engine.

## Evolução P2+

Adapters de mercado, watchdogs e replay já alimentam o mesmo `ingestSnapshot`. Evidência operacional e promoção continuam nos gates P3–P9 do roadmap.
