# Evidência — Control Plane P9 publicado

**Data:** 23/07/2026
**Domínio:** https://robot.fracta.online
**Commit testado:** `b39b737dc76451b9a00588a2c4bed0bbdfb432da`
**Modo:** `shadow`
**Estratégia/instância:** `midas-carry-v1` / `midas-carry-v1:btc5m:primary`

## Resultado

PASS para iniciar a campanha shadow supervisionada. Não houve envio de ordem real.

| Verificação | Resultado |
|---|---|
| `npm run ci` | PASS — 146 testes |
| UI Coolify | `running:healthy`, commit `b39b737` |
| Engine Coolify | `running:healthy`, commit `b39b737` |
| Domínio público | Novo login e dashboard P9 |
| Login | HTTP 200 com credencial configurada; acesso anônimo negado |
| UI → Engine privada | PASS via `http://data-robot-engine:3201` |
| Health | HTTP 200, `ready=true` |
| Catálogo | MIDAS `canary-approved`, TFC `registered`, fixture `shadow-approved` |
| Estado final | Engine `ARMED` internamente; operador `DISARMED`; entradas bloqueadas |
| Posição/ordens | posição 0, ordens 0, órfãs 0 |
| Commit no painel | `b39b737` |

## Drill operacional shadow

Executado pelo mesmo proxy autenticado usado pelo browser:

1. `reconcile` → 200;
2. `checkpoint` → 200;
3. `arm → pause → stop` → 200 em todas as etapas;
4. `cancel-all` sem ordens → 200;
5. `flatten` já flat → 200;
6. `rollback` desarmado/sem ordens → 200;
7. `kill` → `HALTED`, `killActive=true`;
8. restart controlado no Coolify;
9. recovery → `ready=true`, `operatorState=DISARMED`, `entryEnabled=false`, posição 0 e ordens 0.

Todo o drill ocorreu em `shadow`. `ENGINE_LIVE_ENABLED=0` e `ENGINE_START_ARMED=0`.

## Segurança operacional

- `DASHBOARD_USER`/`DASHBOARD_PASSWORD` ficam somente no ambiente da UI.
- `ENGINE_OPS_TOKEN` é o mesmo nos dois containers, fica fora do browser e é exigido pela Engine.
- O domínio público expõe somente a UI; `:3201` permanece privado.
- Confirmação é validada na UI e novamente na Engine.
- Audit JSONL registrou start, checkpoints e ações operacionais.

## Próximo gate

Manter MIDAS em shadow/desarmado, iniciar a coleta contínua de eventos e revisar diariamente:

- disponibilidade e staleness dos feeds;
- decisões e bloqueios de risk;
- posição/ordens/órfãs;
- p95/p99;
- checkpoints/recovery;
- discrepâncias entre intenção e execução simulada.

Promoção live continua exigindo aprovação humana e os gates do [runbook P9](./p9-canario-continuo.md).
