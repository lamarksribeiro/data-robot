# Ambientes — local, shadow, canary, production

| Ambiente | Dinheiro real | Papel | Como roda hoje |
|----------|---------------|-------|----------------|
| **local** | Só com `--live` explícito | Dev, latência VPN, dry-run | PC + `.env` |
| **shadow** | Não | Mesmo pipeline da engine; sink de execução simulado | Ainda não (P1+) |
| **canary** | Sim, budget mínimo | Micro-live / degraus de promoção | Servidor Giovanna / Coolify com limites |
| **production** | Sim, budget aprovado | Operação limitada pós P9 | Processo engine separado da UI |

## Regras comuns

- `live=false` por padrão em todo ambiente.
- Qualquer script que poste ordem exige `--live` (exit 2 se omitido).
- Secrets só no `.env` do host; nunca no frontend `public/`.
- `npm start` / Docker atual servem **somente** a UI estática — não é a engine.

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
