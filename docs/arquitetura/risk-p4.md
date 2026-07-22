# Risk P4 — fail-closed, kill, persistência

Status: **código endurecido** (2026-07-20). O canário executa preflight read-only real; ensaios de recovery live continuam pendentes.

## Módulos (`src/risk/`)

| Arquivo | Papel |
|---------|-------|
| `createRiskEngine.js` | Pre-trade + limites + audit |
| `preflight.js` | Gate síncrono fail-closed; check ausente bloqueia live |
| `livePreflight.js` | Auth/identidade, clock, balance/allowance, geoblock e ordens abertas reais |
| `accountBook.js` | Exposição agregada multi-instância |
| `circuitBreaker.js` | Abre após N falhas consecutivas |
| `killSwitch.js` | Trip + listeners |
| `audit.js` | Reason codes + métricas |
| `reasons.js` | Códigos estáveis |

## Engine

- `start()` falha fechado se preflight negar
- `kill()` / `safeShutdown()` → HALTED + cancel remoto verificado, com `cancelAll` de emergência
- `checkpoint()` / `restore()` — strategy state migrável + OMS journal + risk snapshot duráveis
- deadline é revalidado no risk e no executor
- `REVERSE` live é negado até P8 implementar saga de duas pernas

## Limites default

- notional/ordem e /evento, exposição conta, perda diária, ordens/min
- piso tático 4s (só CANCEL abaixo)
- 1 posição / instância; 1 ENTER ativo / evento

## Gate

Falhas injetadas (geoblock, health, notional, circuit, kill, exposição global) cobertas em `test/risk-p4.test.js`.

Gate ops ainda aberto: restart real com ordem aberta/partial/posição e reconciliação antes de `ARMED`.

## Multi-mercado na mesma conta

BTC 5m e ETH 5m podem operar como instâncias distintas, mas não possuem saldos independentes. O `accountBook` atual prova agregação em memória/testes; antes de multi-mercado live, o coordenador da conta deve ser compartilhado e durável, com:

- reserva atômica de saldo/exposição entre instâncias;
- limites globais de perda, rate e ordens, além dos limites por `marketScope`;
- kill global e kill por instância;
- recovery conjunto antes de qualquer instância voltar a `ARMED`.

Dois processos live com a mesma conta e risk apenas local são fail-closed. Ver [ADR-002](./adr-002-strategy-catalog-supervision.md).
