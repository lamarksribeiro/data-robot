# Risk P4 — fail-closed, kill, persistência

Status: **implementado** (2026-07-18). Sem rede/VPN — checks de preflight são injetáveis.

## Módulos (`src/risk/`)

| Arquivo | Papel |
|---------|-------|
| `createRiskEngine.js` | Pre-trade + limites + audit |
| `preflight.js` | auth / geoblock / clock / balance / liveEnabled |
| `accountBook.js` | Exposição agregada multi-instância |
| `circuitBreaker.js` | Abre após N falhas consecutivas |
| `killSwitch.js` | Trip + listeners |
| `audit.js` | Reason codes + métricas |
| `reasons.js` | Códigos estáveis |

## Engine

- `start()` falha fechado se preflight negar
- `kill()` / `safeShutdown()` → HALTED + cancel resting (OMS)
- `checkpoint()` / `restore()` — strategy state migrável + OMS journal + risk snapshot

## Limites default

- notional/ordem e /evento, exposição conta, perda diária, ordens/min
- piso tático 4s (só CANCEL abaixo)
- 1 posição / instância; 1 ENTER ativo / evento

## Gate

Falhas injetadas (geoblock, health, notional, circuit, kill, exposição global) cobertas em `test/risk-p4.test.js`.
