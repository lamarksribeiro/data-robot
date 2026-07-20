# Deploy data-robot no Coolify Giovanna

**App:** `data-robot` (`hntw925e58wh7y0jcal0linv`)  
**Painel:** https://coolify.giovannarosito.com  
**Projeto:** GoldenLens / production  
**UI:** https://robot.giovannarosito.com (ativo)

## Domínios

| Domínio | Estado |
|---------|--------|
| `robot.giovannarosito.com` | DNS A → `65.21.146.77`, HTTPS OK |
| `robot.fracta.online` | Configurado no Coolify; DNS Cloudflare ainda aponta para origem antiga |

### Migrar `robot.fracta.online` (Cloudflare)

No DNS de `fracta.online`:

1. Registro **A** (ou CNAME) de `robot` → origem `65.21.146.77` (IP público do Giovanna).
2. Se usar proxy laranja Cloudflare: SSL/TLS = Full (strict) depois do Let’s Encrypt no Traefik.
3. Remover/atualizar o apontamento antigo (Brutus / tunnel).
4. Validar: `curl -sI https://robot.fracta.online` e conferir conteúdo igual ao de `robot.giovannarosito.com`.

Coolify já tem FQDN: `https://robot.giovannarosito.com,https://robot.fracta.online`.

## Smoke no servidor

```bash
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
