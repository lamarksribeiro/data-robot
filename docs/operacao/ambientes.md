# Ambientes — local, shadow, canary, production

| Ambiente | Dinheiro real | Papel | Como roda hoje |
|----------|---------------|-------|----------------|
| **local** | Só com `--live` explícito | Dev, latência VPN, dry-run | PC + `.env` |
| **shadow** | Não | Mesmo pipeline da engine; sink de execução simulado | Código disponível; campanha ≥100 eventos reais pendente |
| **canary** | Sim, budget mínimo | Micro-live / degraus de promoção | Harness disponível; campanha bloqueada pelos gates P3–P5 |
| **production** | Sim, budget aprovado | Operação limitada pós P9 | Processo engine separado da UI |

## Regras comuns

- `live=false` por padrão em todo ambiente.
- Qualquer script que poste ordem exige `--live` (exit 2 se omitido).
- Secrets só no `.env` do host; nunca no frontend `public/`.
- `npm start` / Docker atual servem **somente** a UI estática — não é a engine.
- Engine/control plane fora de localhost exige `ENGINE_OPS_TOKEN`.
- Modo live exige preflight real, User WS autenticado e heartbeat CLOB antes de `ARMED`.

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
Runbook TFC: [tfc-validacao-real.md](../tfc-validacao-real.md).
