# Data Robot

Executor de trading real do ecossistema GoldenLens para mercados Polymarket (BTC 5 minutos), via `@polymarket/clob-client-v2` na Polygon Mainnet.

**Status:** pacote **1.10.0** — núcleo strategy-agnostic P0–P5 e proteções live implementados; TFC V7 fornece a referência P6/P7, ainda sem gate operacional aprovado. Não é produção autônoma. UI oficial: https://robot.fracta.online (Coolify Giovanna). **MIDAS Carry V1** é a próxima candidata (ainda só no `data-backtest`). **Trilha ágil:** engine `:3201` + drills → plugin MIDAS → shadow ≥20 → 3 micros ($1) → EXIT (P8); soak 7d / 10 dias só para P9.

Estratégias aprovadas devem ficar disponíveis em um catálogo explícito e ser selecionadas por configuração. Instâncias de mercados distintos — por exemplo BTC 5m e ETH 5m — podem coexistir na mesma conta, desde que compartilhem coordenação global e durável de saldo, risk, OMS e recovery. Concorrência de estratégias no mesmo mercado exige um gate adicional de conflito/netting.

Substitui o `polymarket-robot` como base do novo desenvolvimento.

## Início rápido

```bash
cd data-robot
npm install
cp .env.example .env
# Preencher POLYMARKET_PRIVATE_KEY e POLYMARKET_FUNDER_ADDRESS

npm run derive-key:write
npm run check:api-key
npm run test:connection
npm run ci
```

## Scripts

| Comando | Descrição |
|---------|-----------|
| `npm run check:api-key` | Valida alinhamento API key `.env` vs derivada |
| `npm run check:architecture` | ADR-001: core não importa strategy/tfc |
| `npm run derive-key` | Imprime credenciais L2 derivadas (nonce 0) |
| `npm run derive-key:write` | Grava credenciais derivadas no `.env` |
| `npm run test:connection` | Smoke test CLOB + saldo + perfil Gamma |
| `npm run test:order -- --live --wait 15` | Ordem teste UP (**exige --live**) |
| `npm run lint` / `npm test` / `npm run ci` | Qualidade local / CI |
| `npm run engine:serve` | Engine contínua + snapshots (`fixture` por default) + control HTTP (`:3201`) |
| `npm run engine:soak` | Soak com fixtures; suporta `--duration-hours` e `--interval-ms` |
| `npm run tfc:watch` | Gates TFC V7 observe-only |
| `npm run tfc:micro-entry` | Legado: dry-run/micro CLOB direto (não usar p/ promoção) |
| `npm run tfc:micro-live` | P7: micro-entrada via engine (`--live` para real) |
| `npm run tfc:latency -- --live` | Latência create/get/cancel (**exige --live**) |

## Documentação

- [Plano de desenvolvimento](./docs/plano-desenvolvimento.md) — arquitetura-alvo, P0–P9, DoD
- [ADR-001 engine ≠ estratégia](./docs/arquitetura/adr-001-engine-strategy-separation.md)
- [ADR-002 catálogo + supervisão](./docs/arquitetura/adr-002-strategy-catalog-supervision.md)
- [Observabilidade P5](./docs/arquitetura/observability-p5.md) — control plane / Engine Ready
- [TFC V7 P6](./docs/arquitetura/tfc-v7-p6.md) — plugin no contrato
- [Micro-live P7](./docs/arquitetura/micro-live-p7.md) — canário via engine
- [Deploy Giovanna](./docs/operacao/deploy-giovanna.md) — Coolify + `robot.fracta.online`
- [Ambientes](./docs/operacao/ambientes.md) — local / shadow / canary / production
- [Validação TFC V7](./docs/tfc-validacao-real.md) — runbook baseline do plugin TFC (não promove MIDAS por herança)
- [docs/](./docs/) — índice completo

## Estrutura

```
src/
  index.js            # entry da biblioteca
  composition/        # liga engine ↔ plugins
  engine/             # runtime P1
  market/             # snapshots P2
  oms/                # OMS + journal + reconciler P3
  executor/           # transport sim + user channel
  risk/               # preflight, limites, kill P4
  observability/      # metrics, logs, alerts, SLOs P5
  control/            # health, HTTP, soak, fault injection P5
  strategy/           # fixtures + conformidade + tfcV7 (P6)
  tfc/                # preset + avaliações puras (plugin usa)
  cli/ clob/ feeds/ markets/ runs/
scripts/ test/ public/
```

## Projetos relacionados

- `clob-client-v2` — SDK CLOB
- `data-colector` — ticks históricos
- `data-backtest` — backtests / estratégias
- `polymarket-web-api` — sessão browser para diagnóstico
