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
- Engine sem FQDN público, acessível apenas na rede/host do Coolify; app `running:healthy` (commits MIDAS no `main`, ex. `b1496ee`).
- Checkpoints e logs de shadow MIDAS persistem no volume `rx06uazamupj1w98pvl2b1d9-engine-runs`, montado em `/usr/src/app/runs` (inclui `runs/midas-shadow/`).
- Secrets: env no Coolify (não commitar `.env`).
- Engine Ready usa fixtures e **não** depende de TFC nem MIDAS ([ADR-002](../arquitetura/adr-002-strategy-catalog-supervision.md)).

## Próximos passos — sequência definitiva (só MIDAS)

Detalhe: [plano §3](../plano-desenvolvimento.md#o-que-vamos-seguir-sequência-definitiva-deste-ciclo).

**Feito:** A1/A2 + plugin MIDAS + CI + **shadow ≥5 ENTER** (22/07).  
Evidência: [evidencia-midas-shadow-2026-07-22.md](./evidencia-midas-shadow-2026-07-22.md).  
**Seguir:** 3 micros $1 enter/hold → EXIT depois.  
**Não seguir agora:** smoke TFC, UI, soak 7d.

## Evidência Engine Ready ágil — 22/07/2026

- deploy e healthcheck Coolify: `running:healthy`;
- `/health`: `ok=true`, `ready=true`, `feedsOk=true`, `recoveryOk=true`;
- `/ready`: `ready=true` antes dos drills;
- restart 1 e 2: health voltou e posição shadow `UP`, qty `2`, foi preservada;
- kill autenticado: estado `HALTED`, `killActive=true`, readiness fechada;
- restart pós-kill: `ARMED`, `killActive=false`, `ready=true`, sem ordem aberta/órfã;
- checkpoints cresceram de 4 para 32 arquivos no mesmo volume durante os drills.

Pendente para completar o gate operacional: soak contínuo ≥4h (ideal 24h). Nenhuma ordem real foi enviada nesta etapa.

## Evidência MIDAS shadow sprint — 22/07/2026

- **PASS** `ok=true`, `count=5`, `timedOut=false` (poll 50 ms, Giovanna).
- 5 ENTER em mercados BTC 5m distintos (~14:39Z–15:09Z); ver tabela completa na [evidência dedicada](./evidencia-midas-shadow-2026-07-22.md).
- Overnight pré-fix: 1 ENTER / ~81 eventos — posição shadow não zerava na rotação; corrigido em `b1496ee`.
- Artefatos: `/usr/src/app/runs/midas-shadow/LAST.done` e `sprint-20260722T143455Z.log`.
- Micro-live #1 OK (22/07): [evidencia-midas-micro-live-2026-07-22.md](./evidencia-midas-micro-live-2026-07-22.md). Próximo: micros #2 e #3.
