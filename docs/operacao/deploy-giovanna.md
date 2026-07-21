# Deploy data-robot no Coolify Giovanna

**App:** `data-robot` (`hntw925e58wh7y0jcal0linv`)  
**Painel:** https://coolify.giovannarosito.com  
**Projeto:** GoldenLens / production  
**UI oficial:** https://robot.fracta.online

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

- Container = UI sirv `:3200` + código para CLIs via `docker exec`.
- Engine long-lived (`Dockerfile.engine` / `:3201`) ainda não é serviço separado no Coolify.
- Secrets: env no Coolify (não commitar `.env`).

## Próximos passos (ops + produto)

1. Commit/redeploy do endurecimento live (ACK≠fill, user WS, preflight) se ainda estiver só no working tree.
2. Subir serviço da **engine** (`Dockerfile.engine`, `:3201`) no Giovanna, separado da UI.
3. Portar **MIDAS Carry V1** (`btc-champion-v1`) para o `data-robot` (plugin + paridade vs lab).
4. Shadow MIDAS no Giovanna; soak Engine Ready ≥7d; só então micro-live com cap canário.
5. P8 (saídas live) antes de qualquer canário contínuo / P9.
