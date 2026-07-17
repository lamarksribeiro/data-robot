# Validação TFC V7 em conta real

Runbook incremental para validar a **Terminal Favorite Carry V7 Danger Floor** no `data-robot` com exposição controlada. O roadmap, a arquitetura e os gates de promoção estão no [plano de desenvolvimento](./plano-desenvolvimento.md).

> `--live` movimenta dinheiro real. Nunca execute uma fase live sem concluir e registrar a fase anterior.

> **Exceção perigosa no código atual:** `npm run tfc:latency` envia uma ordem real mesmo sem flag `--live`. Até P0 corrigir essa interface, trate o comando como live e só o execute com autorização e monitoramento explícitos.

## Princípios

1. Validar um subsistema por vez e guardar evidência reproduzível.
2. Dry-run e shadow antes de toda nova ação live.
3. Falhar fechado quando conta, mercado, feed, relógio ou risco estiverem inválidos.
4. Usar a mesma API key derivada do navegador quando a conferência visual for necessária.
5. Tratar resposta de POST como aceite, não como prova de fill ou posição.
6. Não criar ação tática abaixo de 4s; só cancelamento protetivo é permitido.
7. Usar budget de canário separado do `entryBudget=10` do preset V7.

## Dependência da engine genérica

Este runbook valida a TFC V7, não define a arquitetura da engine. A implementação válida deve executar a TFC pelo contrato de estratégia descrito no [plano de desenvolvimento](./plano-desenvolvimento.md): a estratégia recebe contexto normalizado e devolve intenções; somente risk, OMS e executor podem acessar a infraestrutura de ordens.

Os scripts atuais `tfc:watch` e `tfc:micro-entry` ainda fazem orquestração específica e, no caso de `micro-entry`, chamam o CLOB diretamente. Eles servem como protótipos/diagnóstico, mas não devem virar a engine de produção por crescimento incremental.

Para outra estratégia, cria-se outro módulo aderente ao mesmo contrato e um runbook próprio de sinais/paridade. Auth, feeds reutilizáveis, risk global, OMS, executor, journal, recovery, observabilidade e deploy continuam sendo os mesmos.

## Estratégia-alvo

O alvo é `src/tfc/preset-v7.js`, espelho de `data-backtest/labs/strategies/terminal/tfc/presets/btc-champion-v7.json`:

- entrada taker quando todos os gates passam entre 30s e 5s;
- late flip exit/reverse entre 8s e 4s;
- reverse limitado por ask máximo de 0,95;
- danger exit em [4s, 5s) quando `|signedDistance| < 0,3 × sigma_spot(5s)`;
- `hedgeStopEnabled=false` e `entryMakerEnabled=false`.

A V6 Hybrid é apenas referência histórica. Seu hedge stop não faz parte do plano de produção.

## Estado das fases em 17/07/2026

| Fase | Estado | Evidência / próximo gate |
|---|---|---|
| F0 Conta e auth | Parcial | Scripts existem; tornar checks obrigatórios no startup. |
| F1 Feed + gates | Não validada | Dois logs existentes têm 0 amostras na janela 30→5s. |
| F2 Latência | Baseline concluída | Local 1.723 ms; Giovanna 335 ms de mediana. Falta p95/p99 e confirmação robusta de visibilidade. |
| F3 Entrada dry/micro | Protótipo | `micro-entry` ainda usa preset V6 e não mantém posição/OMS. |
| F4 Late flip exit/reverse | Ausente | Implementar somente após OMS/risk/replay. |
| F5 Danger exit | Ausente | Depende da paridade de volatilidade e de F4. |
| F6 Recovery e risco | Ausente | User WS, journal, heartbeat, restart e kill switch. |
| F7 Canário | Bloqueada | Depende de F0–F6 e critérios do roadmap. |

## F0 — Conta, ambiente e preflight

Comandos read-only:

```powershell
npm run check:api-key
npm run test:connection
```

Critérios:

- auth L2 funciona;
- signer, funder e signature type são coerentes;
- saldo pUSD é suficiente para o limite do canário;
- API key derivada está alinhada quando a UI for usada;
- relógio CLOB está acessível;
- `GET https://polymarket.com/api/geoblock` no **host que executará a engine** retorna `blocked=false`;
- nenhuma credencial aparece em log.

Se qualquer item falhar, não avance.

## F1 — Feed e gates V7 sem ordens

O script atual precisa ser alinhado à V7 antes de virar evidência de promoção. Depois:

```powershell
npm run tfc:watch -- --terminal-only --duration=330
```

Registrar por snapshot:

- evento, token IDs, PTB, BTC e `secsLeft`;
- bids/asks de UP/DOWN e profundidade usada pelo OBI;
- timestamp de origem, recebimento e lag de cada feed;
- versão da estratégia/preset e resultado individual dos gates;
- health de RTDS/CLOB e motivo de qualquer bloqueio.

Critérios mínimos:

- pelo menos 100 eventos em shadow;
- 0 snapshot decisório com RTDS >2s ou CLOB >3s;
- 0 divergência não explicada de evento/PTB/token;
- intenção idêntica à do replay do backtest para o mesmo trace.

Os limites de staleness são iniciais e devem ser calibrados sem relaxar o comportamento fail-closed.

## F2 — Latência e consistência de ordem

### Baseline observada

| Ambiente | Repetições | Ping | Create | Get open | Cancel | Total |
|---|---:|---:|---:|---:|---:|---:|
| Local + VPN | 3 | 284 ms | 586 ms | 568 ms | 572 ms | 1.723 ms |
| Giovanna | 5 | 56 ms | 122 ms | 107 ms | 110 ms | 335 ms |

A meta inicial de total <700 ms no Giovanna foi atendida na mediana. Porém `getOpenOrders()` encontrou a ordem imediatamente em 2/5 tentativas no servidor e 0/3 localmente. Como todas foram canceladas, o teste deve medir tempo até visibilidade com polling e não apenas uma leitura imediata.

Próxima medição, somente após o script exigir confirmação live e cancelar em `finally`:

```bash
npm run tfc:latency -- --label=giovanna --repeat=30 --note="baseline p95/p99"
```

Antes de promover F2, o medidor deve reportar:

- p50, p95, p99 e máximo de create/ack, visibilidade, cancel e total;
- status final de cada ordem, taxa de erro e timeout;
- confirmação pelo user WebSocket e por REST;
- cancelamento garantido no `finally`, inclusive se create/get falhar.

Meta provisória no servidor:

- create p95 <400 ms;
- total p95 <700 ms;
- 100% das ordens reconciliadas e canceladas;
- 0 ordem órfã.

## F3 — Entrada dry-run e micro-live

Pré-requisitos:

- preset V7 efetivamente usado;
- estratégia pura, OMS, user WS, journal e risk engine disponíveis;
- F0–F2 aprovadas;
- limite financeiro do canário explícito.

Sequência:

```powershell
# 1. Apenas intenção
npm run tfc:micro-entry -- --timeout=330

# 2. Ordem mínima e cancelamento/reconciliação
npm run tfc:micro-entry -- --live --cancel --timeout=330

# 3. Fill real, somente após aprovação das etapas anteriores
npm run tfc:micro-entry -- --live --timeout=330
```

O protótipo atual não satisfaz todos esses pré-requisitos. Em especial, uma GTC no ask pode ficar resting se não cruzar; a implementação de produção deve escolher explicitamente GTC/FAK/FOK, usar cap de preço e tratar fill parcial.

Critérios:

- 10 entradas micro-live em dias distintos;
- 100% com timeline intenção → ordem → trade/cancel → posição;
- nenhuma duplicidade, ordem órfã ou violação de cap;
- replay do mesmo evento gera a mesma intenção;
- fee e slippage reconciliados.

## F4 — Late flip exit e reverse

Implementar em blocos:

1. posição simulada e sinal read-only;
2. exit SELL entre 8s e 4s;
3. reverse com saída da posição e entrada no lado oposto;
4. bloqueio do reverse quando ask oposto >0,95, mantendo a regra de exit;
5. tratamento de partial fill em cada perna;
6. cancelamento protetivo de ordem viva no piso; nenhuma nova ação abaixo de 4s.

Casos obrigatórios de replay/falha:

- UP→DOWN e DOWN→UP;
- whipsaw;
- book vazio/stale;
- cap bloqueado;
- janela perdida por latência;
- exit parcial, reverse parcial e resposta CLOB desconhecida;
- restart entre as duas pernas.

Critério live: pelo menos 10 sinais shadow por mecanismo e, depois, micro-live reconciliado sem ação abaixo de 4s.

## F5 — Danger exit V7

No intervalo [4s, 5s), avaliar:

```text
abs(signedDistance) < 0,3 × sigma_spot(5s)
```

Requisitos:

- mesma definição de amostragem/volatilidade do `TerminalFavoriteCarry.gls`;
- saída bloqueada se bid inválido, feed stale ou posição já estiver em transição;
- nenhuma nova tentativa após cruzar o piso de 4s;
- marcação `danger_exit` com sigma, distância, bid, lag e timestamps.

Critério: paridade de sinal em replay, 10 ocorrências shadow e micro-live reconciliado.

## F6 — Recovery, proteção e operação

Validar antes do canário:

- user WebSocket + fallback REST;
- heartbeat/cancel-on-disconnect;
- restart com ordem aberta, partial fill e posição aberta;
- 401, 429, 503, cancel-only, WS desconectado e feed stale;
- kill switch e shutdown gracioso;
- limites de ordem, evento, dia, exposição e falhas consecutivas;
- health, readiness, armed/live e halted como estados distintos.

Critério: soak shadow ≥7 dias, zero divergência não resolvida e rollback/restart ensaiados.

## F7 — Canário e promoção

Escada:

1. budget mínimo fixo;
2. 25% do budget pretendido;
3. 50%;
4. $10 do preset V7.

Cada degrau exige 50 eventos ou 7 dias, o que for maior, sem violação de risco, ordem órfã ou posição divergente. Aumento para $15–20 é uma decisão posterior baseada em dados live e drawdown, não uma consequência automática do backtest.

## Cruzamento API, user WS e UI

Em testes com ordem:

1. **User WS:** fonte primária de updates de ordem/trade.
2. **REST:** reconciliação por order ID e estado agregado.
3. **Data API:** posição/atividade por funder quando aplicável.
4. **UI:** conferência humana; nunca é fonte de verdade para automação.

Se as fontes divergirem, a engine entra em `HALTED`, bloqueia novas entradas e reconcilia antes de continuar.

## Evidência obrigatória por fase

Cada relatório promovido deve conter, sem secrets:

- ambiente/host, commit, Node e versão do SDK;
- strategy/preset version e hash dos parâmetros;
- evento/condition/token IDs;
- timestamps, lags e métricas p50/p95/p99 quando aplicável;
- intenções, reason codes, ordens, trades, fills parciais, fees e saldo/posição reconciliados;
- resultado do gate, divergências e decisão humana de promover/rejeitar.

## Referências

- [Plano de desenvolvimento](./plano-desenvolvimento.md)
- Estratégia: `data-backtest/src/backtestStudio/gls/strategies/TerminalFavoriteCarry.gls`
- Preset campeão: `data-backtest/labs/strategies/terminal/tfc/presets/btc-champion-v7.json`
- [Configuração do `.env`](./polymarket-configuracao-env.md)
- [Latência local vs servidor](./operacao/latencia-local-vs-servidor.md)
- [Order lifecycle](https://docs.polymarket.com/concepts/order-lifecycle)
- [User WebSocket](https://docs.polymarket.com/market-data/websocket/user-channel)
- [Fees](https://docs.polymarket.com/trading/fees)
