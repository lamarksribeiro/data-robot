# Data Robot

Executor de trading real do ecossistema GoldenLens para mercados Polymarket (BTC 5 minutos), via `@polymarket/clob-client-v2` na Polygon Mainnet.

**Status:** protótipo operacional e ferramentas de validação. A engine autônoma, o OMS, os controles de risco e o recovery ainda estão no roadmap; `npm start` serve apenas a UI estática.

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

- [Plano de desenvolvimento](./docs/plano-desenvolvimento.md) — arquitetura-alvo, prioridades, gates e Definition of Done
- [Validação TFC V7](./docs/tfc-validacao-real.md) — runbook incremental para shadow, micro-live e canário
- [docs/](./docs/) — índice completo, configuração e achados operacionais
- [scripts/README.md](./scripts/README.md) — detalhes dos scripts CLI

## Estrutura

```
src/
  config.js           # variáveis de ambiente
  clob/               # cliente CLOB compartilhado
  feeds/              # RTDS e market WebSocket
  markets/            # descoberta BTC 5m e PTB
  tfc/                # gates e presets experimentais
scripts/              # CLI operacional
docs/                 # documentação
public/               # UI estática (sirv; não é a engine)
```

## Projetos relacionados

- `clob-client-v2` — SDK CLOB
- `data-colector` — ticks históricos
- `data-backtest` — backtests
- `polymarket-web-api` — sessão browser para diagnóstico
