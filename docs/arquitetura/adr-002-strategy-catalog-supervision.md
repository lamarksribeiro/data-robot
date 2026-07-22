# ADR-002 — Catálogo de estratégias e supervisão de instâncias

- **Status:** Aceito
- **Data:** 2026-07-21
- **Contexto:** evolução do [ADR-001](./adr-001-engine-strategy-separation.md)

## Contexto

A engine é independente de estratégia, mas um processo precisa saber quais plugins são confiáveis, qual versão/preset pode ser usada e quais instâncias devem rodar. Ter várias estratégias **disponíveis** não significa autorizá-las todas a operar, muito menos simultaneamente com o mesmo capital.

O runtime atual resolve um `strategyId` por instância. O registry já aceita vários plugins e o risk possui identidade/exposição por `strategyInstanceId`, porém `engine:serve` ainda inicia uma única instância e a coordenação live entre instâncias não está operacionalmente validada.

## Decisão

Adotar três camadas distintas:

1. **Approved Strategy Catalog** — allowlist explícita no composition root; contém plugins conhecidos, versão, capabilities e presets permitidos.
2. **Strategy Deployment** — configuração auditável que cria instâncias a partir do catálogo, com `strategyInstanceId`, `strategyId`, `presetId`, modo e estado de aprovação.
3. **Strategy Supervisor** — distribui snapshots, controla lifecycle/checkpoints e consolida health/métricas das instâncias sem mover regras de estratégia para o core.

O catálogo é explícito; não haverá auto-discovery de arquivos em produção. Adicionar ou atualizar plugin exige revisão, suíte de conformidade, paridade e novo artefato/deploy identificável.

## Disponibilidade não é ativação

Estados mínimos por versão + preset:

| Estado | Uso permitido |
|---|---|
| `registered` | unitário, replay e desenvolvimento |
| `shadow-approved` | shadow com dados reais, sem ordens |
| `canary-approved` | micro-live dentro do cap aprovado |
| `live-approved` | produção limitada dentro dos gates P9 |
| `suspended` | nenhuma nova entrada; recovery/cancel continuam permitidos |

Uma estratégia pode permanecer no catálogo e estar desabilitada. Nenhum plugin vira live apenas por estar registrado.

## Política de concorrência por etapas

### Etapa A — agora

- todos os plugins aprovados ficam selecionáveis por configuração;
- cada processo da engine executa uma instância;
- enquanto não houver coordenador global da conta, processos independentes não podem operar live simultaneamente com a mesma conta;
- troca de estratégia exige `HALTED`, cancelamento/reconciliação, checkpoint e novo start;
- Engine Ready é aprovado com fixtures, sem depender de TFC, MIDAS ou resultado financeiro.

### Etapa B — supervisor e multi-mercado

- várias instâncias `dry-run`/`shadow` podem compartilhar o mesmo market hub;
- estado, journal, métricas, posição simulada e checkpoint permanecem isolados por `strategyInstanceId`;
- falha de um plugin não deve parar as demais instâncias, salvo risco/health global;
- instâncias live de mercados distintos, por exemplo `btc-updown-5m` e `eth-updown-5m`, podem operar simultaneamente quando usam o mesmo coordenador de conta, risk e OMS;
- cada deployment declara `marketScope`; ordens e posições são isoladas por `strategyInstanceId + marketId`;
- `marketScope` deve corresponder a um item de `strategy.manifest.supportedMarkets`;
- saldo, exposição total, perda diária, rate limits e kill switch permanecem globais à conta.

### Etapa C — estratégias concorrentes no mesmo mercado

Mais de uma estratégia live no mesmo `marketScope` ou evento só será liberada quando existirem e forem validados:

- OMS e journal únicos por conta, com atribuição por instância;
- account risk global e durável, não apenas memória local de processo;
- reservas de exposição atômicas;
- recovery conjunto de ordens, posições e capital;
- política de conflito/netting para intenções opostas no mesmo mercado;
- kill switch global e kill por instância;
- soak e fault injection específicos de concorrência.

Executar processos live independentes na mesma conta com risk apenas local é proibido, mesmo em mercados distintos, pois cada processo poderia acreditar que todo o saldo está disponível. Isso não impede BTC 5m e ETH 5m simultâneos; exige apenas coordenação de conta compartilhada.

## Configuração-alvo

```json
{
  "strategies": [
    {
      "strategyInstanceId": "tfc-v7:btc5m:01",
      "strategyId": "tfc-v7",
      "presetId": "btc-champion-v7",
      "marketScope": "btc-updown-5m",
      "mode": "shadow",
      "approval": "shadow-approved",
      "enabled": true
    },
    {
      "strategyInstanceId": "approved-eth-plugin:eth5m:01",
      "strategyId": "approved-eth-plugin",
      "presetId": "approved-eth-preset",
      "marketScope": "eth-updown-5m",
      "mode": "shadow",
      "approval": "shadow-approved",
      "enabled": true
    }
  ]
}
```

Toda decisão/run deve registrar `strategyInstanceId`, `strategyId`, versão do plugin, `presetId`, hash do preset e commit do robot.

O segundo item é deliberadamente conceitual: hoje os plugins existentes declaram apenas `btc-updown-5m`. ETH 5m exige adapter de descoberta/feed normalizado e ao menos um plugin que declare esse mercado em `supportedMarkets`; não exige outra engine.

## Consequências

- MIDAS, TFC e futuras estratégias são plugins disponíveis; nenhuma é dependência da engine.
- Portar MIDAS não bloqueia deploy, soak ou aprovação Engine Ready.
- Cada plugin percorre gates próprios de paridade, shadow, canary e live.
- BTC 5m, ETH 5m e outros escopos podem coexistir sem duplicar a engine, desde que compartilhem coordenação global da conta.
- A primeira entrega não assume a complexidade de estratégias concorrentes no mesmo mercado.
- O supervisor pode ser implementado sem alterar o contrato econômico das estratégias.

## Alternativas rejeitadas

- **Codificar MIDAS/TFC dentro da engine:** viola o ADR-001 e replica infraestrutura por estratégia.
- **Auto-discovery de plugins no filesystem:** reduz auditabilidade e pode ativar código não aprovado.
- **Um processo live independente por estratégia sem coordenador de conta:** não oferece coordenação atômica de capital, OMS e recovery.
- **Concorrência live no mesmo mercado imediatamente:** exige política de conflito/netting ainda não validada.

## Referências

- [ADR-001 — Separação engine / estratégia](./adr-001-engine-strategy-separation.md)
- [Engine P1](./engine-p1.md)
- [Risk P4](./risk-p4.md)
- [Plano de desenvolvimento](../plano-desenvolvimento.md)
