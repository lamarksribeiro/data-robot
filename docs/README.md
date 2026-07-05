# Documentação — Data Robot

Índice da documentação operacional e de integração com a Polymarket.

## Polymarket / CLOB

| Documento | Conteúdo |
|-----------|----------|
| [Ordens abertas: UI vs API e API keys](./polymarket-ordens-abertas-ui-vs-api.md) | Achado principal (jul/2026): por que ordens via robô não apareciam no site, como corrigir e como operar corretamente no futuro |
| [Configuração correta do `.env`](./polymarket-configuracao-env.md) | Checklist de variáveis, derivação de credenciais L2, identidade (signer/funder/signatureType) e validação |

## Projetos relacionados

- `data-robot/` — robô e scripts CLI (este repositório)
- SDK CLOB: `clob-client-v2/`
- Sessão web para diagnóstico: `polymarket-web-api/` (login manual + comparação com o navegador)

## Referências externas

- [Introdução às APIs Polymarket](https://docs.polymarket.com/api-reference/introduction)
- [Autenticação CLOB](https://docs.polymarket.com/api-reference/authentication)
- [Ciclo de vida das ordens](https://docs.polymarket.com/concepts/order-lifecycle)
- [Criar ordens](https://docs.polymarket.com/trading/orders/create)
