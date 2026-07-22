# Deploy data-robot no Coolify Giovanna

**App:** `data-robot` (`hntw925e58wh7y0jcal0linv`)  
**Painel:** https://coolify.giovannarosito.com  
**Projeto:** GoldenLens / production  
**UI oficial:** https://robot.fracta.online  
**Versão de referência no `main`:** `package.json` **1.10.0** (endurecimento live ACK≠fill, User WS, preflight já commitado)

O host de deploy continua sendo o servidor **Giovanna** (Coolify). O domínio público oficial é `robot.fracta.online` (Cloudflare → Giovanna). O hostname legado `robot.giovannarosito.com` **não** é mais usado.

## Domínios

| Domínio | Estado |
|---------|--------|
| `robot.fracta.online` | Oficial — DNS Cloudflare (proxy) → Giovanna `65.21.146.77`; Coolify FQDN único; HTTPS OK |
| `robot.giovannarosito.com` | Retirado do uso oficial (não documentar como URL do robô) |

Coolify FQDN atual: `https://robot.fracta.online`.

## Smoke no servidor

```bash
# Público
curl -sI https://robot.fracta.online

ssh Giovanna
CID=$(docker ps | awk '/hntw925e58wh7y0jcal0linv/{print $NF; exit}')
docker exec "$CID" node scripts/test-connection.js
# Ordem mínima (cuidado: dinheiro real)
# Preferir script em /tmp com --live (PowerShell engole -- no ssh direto)
```

Baseline latência (20/07/2026, 3×): mediana total **~380 ms** (ping 56 / create 148 / getOpen 116 / cancel 123).

## Notas

- Container atual = UI sirv `:3200` + código para CLIs via `docker exec`.
- Engine long-lived (`Dockerfile.engine` / `:3201`) ainda **não** é serviço separado no Coolify.
- Secrets: env no Coolify (não commitar `.env`).
- Engine Ready usa fixtures e **não** depende de TFC nem MIDAS ([ADR-002](../arquitetura/adr-002-strategy-catalog-supervision.md)).

## Próximos passos (ops + produto)

1. Confirmar que o deploy Coolify da UI está no `main` **1.10.0** (redeploy se o container estiver atrasado).
2. Subir serviço da **engine** (`Dockerfile.engine`, `:3201`) no Giovanna, separado da UI; soak/Engine Ready com fixtures.
3. Implementar **catálogo/deployments** explícitos e supervisor (estados de aprovação, `marketScope`) — [ADR-002](../arquitetura/adr-002-strategy-catalog-supervision.md).
4. Portar **MIDAS Carry V1** como plugin (`strategyId: midas-carry-v1`, preset lab `labs/strategies/terminal/midas-carry-v1/presets/btc-champion-v1.json`), sem alterar o core.
5. Shadow MIDAS/TFC; adapter/plugin ETH 5m só se aprovado. BTC+ETH live na mesma conta exigem account risk/OMS/recovery globais.
6. Soak Engine Ready ≥7d; só então micro-live com cap canário **por** plugin/preset.
7. P8 (saídas live genéricas) antes de canário contínuo / P9.
