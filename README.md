# Data Robot

Robô de trading real do ecossistema GoldenLens para mercados Polymarket (BTC 5 minutos), via `@polymarket/clob-client-v2` na Polygon Mainnet.

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
```

## Scripts

| Comando | Descrição |
|---------|-----------|
| `npm run check:api-key` | Valida alinhamento API key `.env` vs derivada (e opcionalmente vs navegador) |
| `npm run derive-key` | Imprime credenciais L2 derivadas (nonce 0) |
| `npm run derive-key:write` | Grava credenciais derivadas no `.env` (**use este**) |
| `npm run test:connection` | Smoke test CLOB + saldo + perfil Gamma |
| `npm run test:order -- --wait 15` | Ordem teste UP; aguarda 15s para conferir na UI |
| `npm run test:order -- --cancel` | Ordem teste e cancela em seguida |

Comparar com sessão do navegador (`polymarket-web-api`):

```bash
npm run check:api-key -- --browser-storage ../polymarket-web-api/storage/polymarket-storage-state.json
```

## Documentação

- [docs/](./docs/) — achado sobre ordens invisíveis na UI e configuração correta
- [scripts/README.md](./scripts/README.md) — detalhes dos scripts CLI

## Estrutura

```
src/
  config.js           # variáveis de ambiente
  clob/               # cliente CLOB compartilhado
scripts/              # CLI operacional
docs/                 # documentação
public/               # placeholder UI (sirv)
```

## Projetos relacionados

- `clob-client-v2` — SDK CLOB
- `data-colector` — ticks históricos
- `data-backtest` — backtests
- `polymarket-web-api` — sessão browser para diagnóstico
