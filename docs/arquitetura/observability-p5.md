# Observabilidade P5 — control plane e Engine Ready (código)

Status: **código endurecido** (2026-07-20). CI sem rede/ordens reais.
**Ops pendente:** Engine Ready **ágil** no Giovanna (horas + drills). Soak ≥7 dias ficou para P9 / operação contínua.

## Separação de processos

| Processo | Porta | Comando |
|----------|-------|---------|
| UI estática | 3200 | `npm start` (sirv) |
| Engine + control HTTP | 3201 | `npm run engine:serve` |
| Soak (sem HTTP) | — | `npm run engine:soak` |

Container da engine: `Dockerfile.engine` (CMD `scripts/engine-serve.js`). O runner usa `ENGINE_SNAPSHOT_SOURCE=fixture` em smoke/soak e `btc5m` para Gamma + RTDS + CLOB. Live exige `ENGINE_MODE=live`, `ENGINE_LIVE_ENABLED=1` **e** source `btc5m`.

## Módulos

### `src/observability/`

| Arquivo | Papel |
|---------|-------|
| `metrics.js` | Contadores + histogramas (p50/p95/p99) |
| `logger.js` | JSON estruturado + redaction de secrets |
| `alerts.js` | Alertas operacionais (`createAlertHub`) |
| `slo.js` | Avaliação de SLOs locais |
| `journalBackup.js` | Checkpoint atômico de engine/OMS/risk/strategy + restore |

### `src/control/`

| Arquivo | Papel |
|---------|-------|
| `health.js` | Probes dependentes de feed, recovery, user WS e órfãs |
| `httpServer.js` | probes/status + catálogo/audit/instâncias + lifecycle e operações OMS autenticadas |
| `engineApp.js` | Composition: engine + métricas + HTTP |
| `faultInjection.js` | 401/429/503, user-WS loss, restart/kill |
| `soak.js` | Soak por iterações ou duração real, com intervalo configurável |

## Endpoints

- `GET /health` — 200 se ok; 503 caso contrário  
- `GET /ready` — readiness da máquina de estados  
- `GET /status` — status da engine  
- `GET /metrics` — snapshot de métricas  
- `POST /control/*` — exige `x-ops-token` e confirmação específica para arm, pause, stop, reconcile, checkpoint, cancel, flatten, rollback e kill;
- `GET /instances`, `/catalog`, `/audit` — visão operacional somente pelo proxy autenticado da UI em produção.

`/health` inclui o estado de `snapshotSource`; `/ready` só abre depois de snapshot elegível e fecha quando fonte/feed deixam de estar aptos.

## Gate Engine Ready

| Item | Código / CI | Ops |
|------|-------------|-----|
| Métricas, logs, alertas, SLOs | ✓ | Calibrar no Giovanna |
| Health/readiness + processo separado | ✓ | Deploy Coolify |
| Fault injection (401/429/503, WS, kill) | ✓ testes | Ensaiar em staging |
| Soak curto (fixtures) | ✓ `engine:soak` | Ágil: ≥4h (ideal 24h) + drills; longo ≥7d só P9 |
| Aprovação sem depender de TFC | ✓ (fixtures) | — |

Engine Ready aprova a infraestrutura de uma instância e independe do plugin. Supervisor/multi-mercado possui gate adicional: health e métricas por instância/`marketScope`, visão agregada da conta, isolamento de falha, reserva concorrente sem duplicidade e recovery conjunto. Ver [ADR-002](./adr-002-strategy-catalog-supervision.md).

Ver checklist no [plano P5](../plano-desenvolvimento.md#p5--resiliência-observabilidade-deploy-e-gate-engine-ready).

Comando operacional planejado:

```bash
npm run engine:soak -- --duration-hours=168 --interval-ms=1000 --json
```

Métrica ou disponibilidade ausente reprova o SLO; não é interpretada como sucesso. O control plane fora de localhost exige `ENGINE_OPS_TOKEN`.
