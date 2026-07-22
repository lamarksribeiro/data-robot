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

## Próximos passos — trilha ágil

Detalhe e critérios: [plano §3](../plano-desenvolvimento.md#próximos-passos--trilha-ágil).

1. Confirmar UI no `main` **1.10.0** (redeploy se atrasada).
2. **Fase A:** subir engine `:3201` + smoke + drills (restart/kill) no mesmo dia — **não** esperar 7 dias.
3. **Fase B (∥ A):** portar plugin **MIDAS** + paridade CI.
4. **Fase C:** shadow sprint ≥20 eventos MIDAS (1 sessão BTC 5m).
5. **Fase D–E:** OMS smoke + **3** micro-lives canário ($1) reconciliados.
6. **Fase F:** P8 EXIT mínimo; reverse depois.
7. Ampliar (10 micros, shadow 100, soak ≥7d) só para **P9 / canário contínuo**.

Catálogo ADR-002 e ETH 5m **não** bloqueiam A–E.
