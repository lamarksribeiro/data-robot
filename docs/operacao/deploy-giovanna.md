# Deploy data-robot no Coolify Giovanna

**App UI:** `data-robot` (`hntw925e58wh7y0jcal0linv`)
**App engine:** `data-robot-engine` (`rx06uazamupj1w98pvl2b1d9`)
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

- UI e engine são containers separados: UI sirv `:3200`; engine long-lived `:3201`.
- Engine sem FQDN público, acessível apenas na rede/host do Coolify; app `running:healthy` no commit `84c02ed`.
- Checkpoints persistem no volume `rx06uazamupj1w98pvl2b1d9-engine-runs`, montado em `/usr/src/app/runs`.
- Secrets: env no Coolify (não commitar `.env`).
- Engine Ready usa fixtures e **não** depende de TFC nem MIDAS ([ADR-002](../arquitetura/adr-002-strategy-catalog-supervision.md)).

## Próximos passos — trilha ágil (revisada)

Detalhe: [plano §3](../plano-desenvolvimento.md#próximos-passos--trilha-ágil-revisada).

1. **A1 concluída (22/07):** app Coolify `data-robot-engine`, `Dockerfile.engine`, porta 3201, `shadow + fixture`; UI não alterada.
2. **A2 concluída (22/07):** `/health` e `/ready` OK; 2 restarts + kill + restart final; posição shadow e checkpoints restaurados; 0 órfã/violação.
3. **B ∥:** portar plugin MIDAS + paridade CI (enquanto A).
4. **D:** OMS smoke com harness **TFC** já existente (`tfc:micro-live` ou create/cancel) — não espera MIDAS.
5. **C → E:** shadow MIDAS ≥20 → 3 micros MIDAS $1.
6. **F:** EXIT live; reverse depois.
7. **G / P9:** 10 micros, shadow 100, soak ≥7d, catálogo/ETH.

## Evidência Engine Ready ágil — 22/07/2026

- deploy e healthcheck Coolify: `running:healthy`;
- `/health`: `ok=true`, `ready=true`, `feedsOk=true`, `recoveryOk=true`;
- `/ready`: `ready=true` antes dos drills;
- restart 1 e 2: health voltou e posição shadow `UP`, qty `2`, foi preservada;
- kill autenticado: estado `HALTED`, `killActive=true`, readiness fechada;
- restart pós-kill: `ARMED`, `killActive=false`, `ready=true`, sem ordem aberta/órfã;
- checkpoints cresceram de 4 para 32 arquivos no mesmo volume durante os drills.

Pendente para completar o gate operacional: soak contínuo ≥4h (ideal 24h). Nenhuma ordem real foi enviada nesta etapa.
