# Engine core

Runtime genérico (P1+). **Não** importa `src/strategy/*` nem `src/tfc/*`.

| Módulo | Papel |
|--------|-------|
| `schemas.js` | MarketSnapshot, TradeIntent, estados |
| `contract.js` | Validação do contrato de plugin |
| `registry.js` | Registro por `strategyId` |
| `runtime.js` | Lifecycle + ingestSnapshot/intents |
| `risk.js` | Limites básicos pré-OMS |
| `sinks.js` | dry-run / shadow / live-stub |

Plugins são ligados só em `src/composition/bootstrap.js`.
