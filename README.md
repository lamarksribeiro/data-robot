# Data Robot

Executor de trading real do ecossistema GoldenLens para mercados Polymarket (BTC 5 minutos), via `@polymarket/clob-client-v2` na Polygon Mainnet.

**Status:** P0–P1 concluídos. Kernel genérico com dry-run/shadow e fixtures. OMS, risk completo, feeds normalizados e TFC-as-plugin ainda no roadmap (P2+). `npm start` serve apenas a UI estática.

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
| `npm run tfc:watch` | Gates TFC V7 observe-only |
| `npm run tfc:micro-entry` | Dry-run micro-entrada V7 (`--live` para real) |
| `npm run tfc:latency -- --live` | Latência create/get/cancel (**exige --live**) |

## Documentação

- [Plano de desenvolvimento](./docs/plano-desenvolvimento.md) — arquitetura-alvo, P0–P9, DoD
- [ADR-001 engine ≠ estratégia](./docs/arquitetura/adr-001-engine-strategy-separation.md)
- [Ambientes](./docs/operacao/ambientes.md) — local / shadow / canary / production
- [Validação TFC V7](./docs/tfc-validacao-real.md) — runbook
- [docs/](./docs/) — índice completo

## Estrutura

```
src/
  index.js            # entry da biblioteca
  composition/        # liga engine ↔ plugins (único lugar)
  engine/             # core P1 — não importa strategy/tfc
  strategy/           # fixtures + conformidade (+ TFC futuro)
  cli/                # gates de segurança (--live)
  clob/ feeds/ markets/
  tfc/                # gates/presets CLI (ainda não plugin)
  runs/               # schema de evidência
scripts/              # CLI operacional
test/                 # node:test
public/               # UI estática (sirv)
```

## Projetos relacionados

- `clob-client-v2` — SDK CLOB
- `data-colector` — ticks históricos
- `data-backtest` — backtests / estratégias
- `polymarket-web-api` — sessão browser para diagnóstico
