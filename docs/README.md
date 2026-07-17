# Documentação — Data Robot

Índice da documentação de desenvolvimento, operação e integração com a Polymarket.

## Desenvolvimento

| Documento | Conteúdo |
|-----------|----------|
| [Plano de desenvolvimento](./plano-desenvolvimento.md) | Engine independente de estratégia, arquitetura-alvo, invariantes, roadmap P0–P9 e Definition of Done |
| [Validação TFC V7 em conta real](./tfc-validacao-real.md) | Runbook F0–F7, evidência exigida e gates de promoção |

## Polymarket / CLOB

| Documento | Conteúdo |
|-----------|----------|
| [Ordens abertas: UI vs API e API keys](./polymarket-ordens-abertas-ui-vs-api.md) | Achado principal (jul/2026): por que ordens via robô não apareciam no site, como corrigir e como operar corretamente no futuro |
| [Configuração correta do `.env`](./polymarket-configuracao-env.md) | Checklist de variáveis, derivação de credenciais L2, identidade (signer/funder/signatureType) e validação |

## Operação e pesquisa aplicada

| Documento | Conteúdo |
|-----------|----------|
| [Latência local vs servidor Giovanna](./operacao/latencia-local-vs-servidor.md) | F2a/F2b: medir no PC (VPN) e no Coolify Giovanna; comparar com `tfc:latency:compare` |
| [Maker vs taker fee (Hopper 3)](./operacao/teste-maker-vs-taker-fee.md) | Taker confirmado; fill maker ainda pendente para concluir a validação local |

## Projetos relacionados

- `data-robot/` — robô e scripts CLI (este repositório)
- SDK CLOB: `clob-client-v2/`
- Sessão web para diagnóstico: `polymarket-web-api/` (login manual + comparação com o navegador)

## Referências externas

- [Introdução às APIs Polymarket](https://docs.polymarket.com/api-reference/introduction)
- [Autenticação CLOB](https://docs.polymarket.com/api-reference/authentication)
- [Ciclo de vida das ordens](https://docs.polymarket.com/concepts/order-lifecycle)
- [Criar ordens](https://docs.polymarket.com/trading/orders/create)
