# Ambientes — local, shadow, canary, production

| Ambiente | Dinheiro real | Papel | Como roda hoje |
|----------|---------------|-------|----------------|
| **local** | Só com `--live` explícito | Dev, latência VPN, dry-run | PC + `.env` |
| **shadow** | Não | Mesmo pipeline da engine; sink de execução simulado | Código disponível; campanha ≥100 eventos reais pendente |
| **canary** | Sim, budget mínimo | Micro-live / degraus de promoção | Harness disponível; campanha bloqueada pelos gates P3–P5 |
| **production** | Sim, budget aprovado | Operação limitada pós P9 | UI: https://robot.fracta.online (Giovanna); engine `:3201` ainda não deployada |

## Regras comuns

- `live=false` por padrão em todo ambiente.
- Qualquer script que poste ordem exige `--live` (exit 2 se omitido).
- Secrets só no `.env` do host; nunca no frontend `public/`.
- `npm start` / Docker atual servem **somente** a UI estática — não é a engine.
- Engine/control plane fora de localhost exige `ENGINE_OPS_TOKEN`.
- Modo live exige preflight real, User WS autenticado e heartbeat CLOB antes de `ARMED`.

## Estratégias e mercados

- Plugins aprovados ficam em catálogo explícito; registro não ativa live.
- Cada instância declara `strategyInstanceId`, versão/preset e `marketScope`.
- BTC 5m e ETH 5m podem operar simultaneamente na mesma conta quando compartilham account risk, OMS e recovery globais; posições/journals continuam isolados por instância + mercado.
- Enquanto essa coordenação global não estiver disponível, dois processos independentes não podem usar a mesma conta em live.
- Duas estratégias live no mesmo mercado/evento exigem arbitragem de conflito/netting e um gate separado.
- Hoje os plugins e adapters implementados cobrem BTC 5m; ETH 5m é uma extensão pendente, não outra engine.

## Labels de run

Para comparar latência:

```bash
npm run tfc:latency -- --live --label=local --repeat=3
npm run tfc:latency -- --live --label=giovanna --repeat=5   # no host canary
npm run tfc:latency:compare
```

O campo `environment` no envelope do run mapeia `giovanna` → `canary` e demais labels → `local` até existirem deploys shadow/production dedicados.

## Promoção

Gates e Definition of Done: [plano de desenvolvimento](../plano-desenvolvimento.md).

Catálogo e supervisão: [ADR-002](../arquitetura/adr-002-strategy-catalog-supervision.md).

Runbook TFC (baseline específico do plugin): [tfc-validacao-real.md](../tfc-validacao-real.md).
