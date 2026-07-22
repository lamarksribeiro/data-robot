# Market P2 — snapshots, health, capabilities, replay

Status: **implementado** (2026-07-18).

## Módulos

| Arquivo | Papel |
|---------|-------|
| `health.js` | Staleness RTDS/CLOB + clock skew |
| `normalize.js` | `marketState` legado → `MarketSnapshot` |
| `eligibility.js` | Gate fail-closed (stale, identidade, secsLeft) |
| `capabilities.js` | Filtra book/price conforme manifest |
| `hub.js` | Rotação de evento, stats de disponibilidade |
| `snapshotSources.js` | Runner contínuo (`fixture` ou BTC 5m real) que alimenta a engine |
| `replay.js` | Captura/replay JSONL canônico |
| `ingest.js` | Bridge snapshot → engine com filtro |

## Limites iniciais

- RTDS stale: `> 2000 ms`
- CLOB stale: `> 3000 ms`
- Sem decisão com `secsLeft < 5` (configurável no gate)
- Snapshot elegível exige `acceptingOrders` (default)

## Replay

```js
import { createReplayRecorder, loadReplayJsonl, assertReplayDeterministic } from '../src/market/replay.js';

const rec = createReplayRecorder();
rec.push(snapshot);
rec.writeJsonl('runs/replay-demo.jsonl');
assertReplayDeterministic(loadReplayJsonl('runs/replay-demo.jsonl'));
```

Canonical = `JSON.stringify` com chaves ordenadas — mesmo stream ⇒ bytes iguais.

## Capabilities

- `fixture-price-cross` (`price`) → book zerado no ingest
- `fixture-spread-wide` (`price`,`book`) → book completo

`engine.ingestMarketSnapshot(snap)` (composition) aplica o filtro automaticamente.

## Fonte contínua

`engine:serve` seleciona a fonte por `ENGINE_SNAPSHOT_SOURCE`:

- `fixture`: smoke/soak determinístico, sem dependência de rede;
- `btc5m`: descoberta e rotação Gamma, PTB, RTDS e CLOB;
- `manual`: nenhum runner; ingestão fica a cargo do chamador.

A fonte não conhece strategy, risk ou OMS. Ela publica `MarketSnapshot`; a composition aplica elegibilidade e capabilities antes de entregar o contexto ao plugin. Falta de evento, PTB, referência BTC, feed saudável ou `acceptingOrders` mantém `/ready` fechado.
