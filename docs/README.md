# Documentação — Data Robot

Índice da documentação de desenvolvimento, operação e integração com a Polymarket.

## Desenvolvimento

| Documento | Conteúdo |
|-----------|----------|
| [Plano de desenvolvimento](./plano-desenvolvimento.md) | Engine independente de estratégia, arquitetura-alvo, invariantes, roadmap P0–P9 e Definition of Done |
| [ADR-001 — Engine ≠ estratégia](./arquitetura/adr-001-engine-strategy-separation.md) | Contrato de plugin; core não importa TFC/strategy |
| [ADR-002 — Catálogo e supervisão](./arquitetura/adr-002-strategy-catalog-supervision.md) | Plugins aprovados, instâncias, multi-mercado BTC/ETH e coordenação global da conta |
| [Engine P1](./arquitetura/engine-p1.md) | Kernel, sinks dry-run/shadow, fixtures e bootstrap |
| [Market P2](./arquitetura/market-p2.md) | Snapshots, health, capabilities, hub e replay |
| [OMS P3](./arquitetura/oms-p3.md) | Ordens, executor sim, journal, reconciler |
| [Risk P4](./arquitetura/risk-p4.md) | Fail-closed, kill, circuit, checkpoint/restore |
| [Observabilidade P5](./arquitetura/observability-p5.md) | Métricas, control HTTP, soak, fault injection; ops Engine Ready |
| [TFC V7 P6](./arquitetura/tfc-v7-p6.md) | Plugin TFC no contrato; ENTER/late flip/danger; paridade sintética; MIDAS é gate separado |
| [Micro-live P7](./arquitetura/micro-live-p7.md) | Canário via engine; harness TFC; campanha por plugin/preset; ACK≠fill |
| [Schema de runs](./arquitetura/runs-schema.md) | Envelope versionado, sanitização e retenção de evidência |
| [Deploy Giovanna](./operacao/deploy-giovanna.md) | Coolify Giovanna, URL oficial `robot.fracta.online`, smoke CLOB, próximos passos |
| [Ambientes](./operacao/ambientes.md) | local / shadow / canary / production |
| [Validação TFC V7 em conta real](./tfc-validacao-real.md) | Baseline específico do plugin TFC; não promove outros plugins por herança |

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
