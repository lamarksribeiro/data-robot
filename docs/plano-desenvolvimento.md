# Plano de desenvolvimento — Data Robot

**Revisado em:** 21/07/2026  
**Estado atual:** protótipo operacional e ferramentas de diagnóstico; **ainda não é um robô autônomo de produção**.  
**URL oficial:** https://robot.fracta.online (Coolify Giovanna).  
**Estratégia-alvo inicial:** **MIDAS Carry V1** (`btc-champion-v1` no `data-backtest`, 19/07/2026). Núcleo de execução = TFC V7 Danger Floor + envelope high-ask / tier. Plugin MIDAS no robot ainda **ausente**.

Este é o roadmap canônico do `data-robot`. O [runbook de validação TFC](./tfc-validacao-real.md) descreve o caminho de evidência em conta real (baseline TFC); a promoção live usa MIDAS. O runbook não substitui este plano.

## 1. Objetivo e limites

Entregar uma engine de trading real, segura e independente de estratégia, inicialmente validada em mercados BTC Up/Down de 5 minutos na Polymarket, que:

- execute estratégias por um contrato estável, sem acoplá-las ao SDK, credenciais, OMS ou infraestrutura;
- hospede inicialmente a **MIDAS Carry V1** com paridade verificável em relação ao `data-backtest` (TFC V7 permanece baseline / núcleo compartilhado);
- não opere quando dados, conta, mercado ou controles de risco estiverem inválidos;
- conheça o ciclo de vida das próprias ordens e posições mesmo após falhas ou reinício;
- possa ser promovido de replay para shadow, micro-live e produção por gates mensuráveis;
- produza evidência suficiente para explicar cada decisão e reconciliar PnL, fills e fees.

Ficam fora deste ciclo:

- descoberta ou otimização de estratégia, que pertencem ao `data-backtest`;
- execução simultânea de múltiplas estratégias antes da MIDAS atingir operação estável; a extensibilidade da engine, porém, é requisito desde o início;
- execução com dinheiro de terceiros;
- decisões táticas abaixo do piso de 4 segundos, exceto cancelamento protetivo.

## 2. Decisões corrigidas nesta revisão

1. **MIDAS Carry V1 é o alvo inicial de teste live.** Preset `btc-champion-v1` (tier 1.5×). Núcleo = TFC V7 Danger Floor; envelope high-ask (`maxAsk` 0.94, `maxDistAbs` 40) + budget em tier. Plugin ainda só no lab (`data-backtest`).
2. **V7 substitui V6 como baseline de execução.** A V6 Hybrid depende de stop-buy sintético. A validação do backtest concluiu que esse mecanismo pode disparar na zona abaixo de 4s, onde o book e a latência não sustentam execução fiel.
3. **F4 não implementará hedge stop da V6.** A sequência correta é late flip exit/reverse da V7/MIDAS e, depois, danger exit no piso de 4s.
4. **Scripts atuais não formam um serviço de produção.** Hoje há feeds, avaliação de gates e CLIs de diagnóstico/micro-ordem; faltam engine contínua em deploy, evidência OMS live e plugin MIDAS.
5. **A UI estática não é o robô.** `npm start` serve somente `public/`. URL oficial da UI: https://robot.fracta.online. A engine deve ser um processo separado (`:3201`), sem secrets no frontend.
6. **A latência média/mediana não basta.** Promoção exige p95/p99 por operação, visibilidade da ordem, taxa de erro e comportamento sob timeout.
7. **REST imediato não é confirmação suficiente.** O canal WebSocket autenticado de usuário deve ser a fonte primária de eventos de ordem/trade; REST será usado para reconciliação.
8. **Maker não significa apenas fee zero.** Maker não paga fee de protocolo e pode receber rebate. A hipótese local de maker ainda precisa de um fill real para ser considerada validada.
9. **O medidor de latência exige `--live`.** Sem a flag, o comando recusa (exit 2) e cancela em `finally` quando a ordem foi criada.
10. **A engine vem antes da estratégia.** Core, OMS, risk, persistência, recovery e observabilidade não podem importar MIDAS/TFC. O primeiro adaptador live de promoção é MIDAS; TFC V7 no robot serve de referência e reuso de helpers.
11. **“Código concluído” não equivale a “gate live aprovado”.** P3–P7 distinguem explicitamente CI/simulação de evidência real no Giovanna.
12. **POST de ordem é somente ACK.** Fill e preço executado vêm do user WS ou de reconciliação REST; FAK pode preencher parcialmente.
13. **REVERSE permanece bloqueado em live.** A promoção exige saga persistida `SELL → reconcile → BUY`, não uma compra isolada do lado oposto.

## 3. Diagnóstico do estado atual

| Área | Estado | Evidência / lacuna |
|---|---|---|
| Auth L1/L2, signer, funder | Código endurecido; ops aberto | `runLivePreflight` valida auth, identidade, saldo/allowance, relógio, geoblock e ausência de ordens abertas. Falta evidência repetida no serviço do Giovanna. |
| Descoberta BTC 5m e PTB | Parcial | Implementada para o slot atual/próximo; faltam retry observável, validação de `acceptingOrders` e testes de transição de evento. |
| RTDS e CLOB market feed | Feito (P2) | Normalização + staleness + hub; WS legado permanece em `src/feeds/`. |
| Engine / contrato de estratégia | Feito (P1+P6 TFC) | Runtime + registry + fixtures + plugin `tfc-v7`. **MIDAS ainda não portada.** |
| Gates de entrada | Feito (P6 TFC) | `evaluateEntryGates` + late flip + danger exit no plugin TFC; MIDAS reusa + tier. |
| Preset de produção | MIDAS pendente no robot | Lab: `btc-champion-v1`. Robot ainda alinha `watch`/`micro-entry` ao preset V7. |
| Entrada real | Feito (P7 código TFC) | `tfc:micro-live` via engine + canary cap; campanha live bloqueada até P3–P5; MIDAS harness ainda inexistente. |
| Saída / reverse / danger exit | Ausente | `evaluateLateFlip` só avalia parte do sinal e não executa ciclo de posição. Danger exit não existe no robô. |
| OMS e user WebSocket | Código live implementado; ops aberto | User WS autenticado, heartbeat CLOB, reconciliação por ordem e detecção de órfãs; validação real prolongada ainda pendente. |
| Risco e kill switch | Código endurecido; ops aberto | Preflight live obrigatório, deadlines, caps, kill/circuit e `REVERSE` bloqueado até P8. |
| Persistência / recovery | Código endurecido; ops aberto | Checkpoint atômico, restore de strategy/OMS/risk e reconciliação antes do start; falta ensaio real com ordem/posição existentes. |
| Observabilidade | Código endurecido; ops aberto | Readiness depende de feed/recovery/user WS; métricas ausentes reprovam SLO; calibragem Giovanna pendente. |
| Testes e CI | Feito | `npm run ci` (lint + architecture + testes); sem rede/ordens reais. |
| Deploy | UI oficial no ar | https://robot.fracta.online no Coolify Giovanna; engine `:3201` ainda não é serviço separado; soak ≥7d pendente. |

### Próximos passos (ordem)

1. **Commit + redeploy** do endurecimento live (working tree 1.10.0) em https://robot.fracta.online.
2. **Deploy da engine** (`Dockerfile.engine` / `:3201`) no Giovanna, separada da UI.
3. **Plugin MIDAS Carry V1** no robot (`btc-champion-v1` + paridade sintética vs GLS do lab).
4. **Shadow MIDAS** + **soak Engine Ready** (≥7d) no Giovanna.
5. **Micro-live MIDAS** com canary cap (após gates reais P3–P5).
6. **P8** saídas live (late flip / reverse / danger) → depois **P9** canário contínuo.

### Evidência já obtida

- Em 15/07/2026, o relatório local mediu mediana total de **1.723 ms** em 3 tentativas.
- No servidor Giovanna, a mediana foi **335 ms** em 5 tentativas, abaixo da meta inicial de 700 ms.
- A ordem foi encontrada no `getOpenOrders()` imediato em apenas **2/5** tentativas no servidor e **0/3** localmente, embora todas tenham sido canceladas. Isso indica que a leitura imediata sofre consistência eventual ou que a medição precisa de polling; não é falha de cancelamento comprovada.
- Os dois logs `watch` existentes não contêm amostras na janela terminal de 5–30s; portanto F1 ainda não foi validada.
- O teste taker confirmou um fill classificado como `TAKER` e fee esperada de aproximadamente **$0,12810**. O teste maker não obteve fill; a perna maker continua inconclusiva.

Os arquivos em `runs/` são evidência local e estão ignorados pelo Git. Resultados de promoção devem virar relatórios sanitizados e versionados, sem credenciais, endereços completos ou dados desnecessários da conta.

## 4. Arquitetura-alvo

```text
Polymarket/Gamma/RTDS
        │
        ▼
adapters de mercado ──► snapshot/eventos normalizados ──► engine runtime
        │                                                   │
        │                                     strategy registry + instance
        │                                                   │
        └──────── watchdogs ◄──── trade intents ◄───────────┘
                                      │
                                      ▼
                              risk engine global
                                      │ aprovado
                                      ▼
                             OMS + execution adapter
                               │                  │
                               ├── CLOB REST      └── user WebSocket
                               ▼
                  journal + reconciler + métricas + alertas
                                      │
                                      ▼
                           API local / UI somente leitura
```

### Componentes e responsabilidades

| Componente | Responsabilidade | Não deve fazer |
|---|---|---|
| `market` | Encontrar evento, tokens, PTB, início/fim e estado de negociação | Enviar ordens |
| `feeds` | Manter book/spot normalizados, timestamps e saúde | Decidir estratégia |
| `engine` | Ciclo de vida, scheduler, instâncias de estratégia e roteamento de eventos/intenções | Conhecer regras TFC ou chamar SDK diretamente |
| `strategy registry` | Resolver `strategyId`, versão, preset e capabilities | Escolher estratégia implicitamente |
| `strategy/*` | Transformar contexto normalizado em intenção determinística e estado serializável | Chamar SDK/API, ler `.env`, gravar arquivo ou controlar risco global |
| `risk` | Aceitar/rejeitar intenção por limites e saúde | Inventar sinal |
| `oms` | Idempotência e estados de ordem/fill/cancel | Alterar parâmetros da estratégia |
| `executor` | Traduzir intenção para GTC/FAK/FOK com cap explícito | Presumir fill pela resposta de POST |
| `journal` | Registrar eventos append-only e checkpoints | Armazenar secrets |
| `reconciler` | Comparar journal, user WS, REST, saldo e posições | Silenciar divergência |
| `control plane` | Start/stop, dry-run/live, kill switch, health/readiness | Servir chave privada ao browser |

### Contrato de estratégia

A engine não deve ter um `if (strategy === 'tfc')`. Ela carrega uma implementação registrada por configuração explícita, por exemplo `STRATEGY_ID=tfc-v7` e `STRATEGY_PRESET=btc-champion-v7`.

Contrato conceitual mínimo:

```javascript
strategy = {
  manifest: { id, version, stateVersion, supportedMarkets, capabilities },
  validatePreset(preset),
  initialize(context, preset),
  onSnapshot(context, strategyState),
  onExecutionEvent(context, strategyState, executionEvent),
  migrateState?.(oldState, fromVersion),
}

result = {
  state,        // JSON serializável; engine persiste
  intents,      // ENTER | EXIT | REVERSE | CANCEL com limites explícitos
  diagnostics,  // sinais/gates para logs e shadow; sem secrets
}
```

O `context` é somente leitura e contém snapshot de mercado, relógio, posição consolidada, ordens da instância, saldo/exposição permitidos e health. Uma intenção descreve a decisão econômica (`side`, `budget/quantity`, `maxPrice`, `deadline`, `reason`); risk e executor decidem se ela pode ser enviada e traduzem para GTC/FAK/FOK.

Regras do contrato:

- nenhuma estratégia recebe `ClobClient`, private key, filesystem, `process.env` ou função de rede;
- toda intenção recebe `strategyInstanceId`, `marketId`, `intentId` determinístico e versão do preset;
- o estado da estratégia é serializável, versionado e migrável;
- o core oferece uma suíte de conformidade comum para qualquer estratégia;
- necessidades adicionais de dados entram como capabilities/adapters normalizados, nunca como `fetch` dentro da estratégia;
- limites globais agregam todas as estratégias, mesmo quando cada instância cumpre seu limite local.

### Fluxo de execução

1. A engine faz preflight, recovery e carrega a estratégia/preset pelo registry.
2. Market/feed adapters publicam snapshots normalizados.
3. A engine entrega snapshot, posição e estado à estratégia.
4. A estratégia devolve novo estado, diagnósticos e zero ou mais intenções; não envia ordens.
5. Risk valida health, limites locais/globais, idempotência e compliance.
6. OMS/executor converte intenção aprovada em ordem e acompanha ACK, partial fill, fill, cancel ou estado desconhecido.
7. User WS/REST geram eventos de execução; a engine atualiza posição/journal e os devolve à estratégia.
8. Restart reconstrói engine e instância pelo journal antes de aceitar nova intenção.

Para adicionar outra estratégia, implementa-se esse contrato, seu preset/schema e os testes de conformidade. OMS, risk, feeds básicos, journal, recovery, deploy e observabilidade permanecem os mesmos. Se a nova estratégia exigir outro mercado ou dado, adiciona-se um adapter/capability reutilizável — não uma segunda engine.

Estados mínimos da engine:

```text
BOOT → ACCOUNT_READY → MARKET_SYNCING → OBSERVING → ARMED
                                                ├→ ENTRY_PENDING → POSITION_OPEN
                                                │                    ├→ EXIT_PENDING
                                                │                    └→ REVERSE_PENDING
                                                └→ HALTED ◄──────────────┘
```

Transições precisam ser idempotentes, persistidas e acompanhadas por `reason`, `eventId`, `strategyVersion`, `runId` e timestamp local/servidor.

## 5. Invariantes de segurança

Nenhuma fase live é aprovada enquanto estes invariantes não estiverem automatizados:

- `live=false` por padrão; ativação live explícita, auditável e específica por ambiente.
- Startup falha fechado se auth, funder, signature type, saldo, relógio ou geoblock não estiverem válidos.
- Nenhuma nova entrada com mercado fechado, `acceptingOrders=false`, evento divergente ou menos de 5s restantes.
- Nenhuma decisão com RTDS/CLOB stale; limites iniciais: RTDS >2s e CLOB >3s interrompem novas ações e geram alerta. Os limites serão recalibrados com dados de produção.
- Nenhuma nova ação tática abaixo de 4s. A única exceção é cancelamento protetivo de ordem viva.
- Toda ordem tem notional máximo, cap de preço/slippage, token/evento esperados e chave de idempotência.
- No máximo uma posição e uma intenção ativa por instância/evento no primeiro release; risk também limita exposição agregada entre estratégias.
- Limites configuráveis: notional por ordem/evento, exposição total, perda diária, ordens por minuto, falhas consecutivas e slippage realizado.
- Fill parcial é posição real; nunca é tratado como falha total ou fill completo.
- Heartbeat/cancel-on-disconnect para ordens resting e cancelamento no shutdown.
- `HALTED` cancela ordens abertas, bloqueia entradas e preserva/reconcilia posições; não tenta liquidar cegamente.
- Secret, passphrase e private key nunca aparecem em logs, UI, relatórios ou mensagens de erro.

## 6. Roadmap por gates

As fases são sequenciais para promoção, mas tarefas internas sem dependência podem avançar em paralelo. Não há estimativa de calendário confiável até fechar P0 e medir a capacidade real do time.

### P0 — Baseline confiável e governança

**Status:** concluído (2026-07-18).

Entregáveis:

- [x] este documento e o runbook como fontes canônicas;
- [x] alinhar `watch`/`micro-entry` ao preset V7 e eliminar ambiguidade V6/V7;
- [x] corrigir metadados de pacote: `main` → `src/index.js` (biblioteca; engine ainda ausente);
- [x] adicionar `test`, `lint` e CI, com Node 22 fixado;
- [x] ADR da separação engine/estratégia + `npm run check:architecture`;
- [x] schema versionado para `runs` e política de retenção/sanitização;
- [x] documentar ambientes `local`, `shadow`, `canary` e `production`;
- [x] `tfc:latency` e `test:order` exigem `--live` (exit 2 sem a flag); cancel em `finally` na latência.

Gate de saída:

- [x] instalação limpa, lint e testes rodam em CI;
- [x] nenhum comando documentado está ausente (ver scripts/README);
- [x] nenhum teste live pode ser acionado por comando ambíguo ou configuração default.

### P1 — Kernel genérico e contrato de estratégia

**Status:** concluído (2026-07-18).

Entregáveis:

- [x] engine runtime sem dependência de TFC: lifecycle, strategy registry e composition root;
- [x] contrato com manifest, preset, estado versionado, intents e diagnostics;
- [x] schemas runtime para `MarketSnapshot`, `PositionView`, `ExecutionEvent`, `TradeIntent` e `StrategyResult`;
- [x] modo shadow que percorre o mesmo pipeline e troca somente o execution sink;
- [x] duas estratégias fictícias (`fixture-price-cross`, `fixture-spread-wide`);
- [x] suíte de conformidade + regra arquitetural contra imports proibidos.

Gate de saída:

- [x] as duas estratégias fictícias rodam sem alteração no core;
- [x] dry-run, shadow e live compartilham máquina de estados e intents;
- [x] o grafo de dependências prova que o core não importa nenhuma estratégia concreta.

Ver [arquitetura/engine-p1.md](./arquitetura/engine-p1.md).

### P2 — Dados de mercado, relógio e replay genéricos

**Status:** concluído (2026-07-18).

Entregáveis:

- [x] adapters normalizados de evento, token, PTB, RTDS e CLOB book (`src/market/normalize.js` + hub);
- [x] rotação de mercado, limpeza de book e watchdogs de feed/clock (`health.js`, `eligibility.js`, `hub.js`);
- [x] capabilities declaradas com filtro no ingest (`capabilities.js` + `ingestMarketSnapshot`);
- [x] captura e replay determinístico sem estratégia (`replay.js`).

Gate de saída:

- [x] 0 snapshot elegível com feed stale ou identidade de mercado incorreta (testes);
- [x] disponibilidade ≥99,5% na janela sintética saudável (teste hub);
- [x] replay do mesmo stream produz snapshots byte-equivalentes (canonical JSONL);
- [x] fixture price-only vs book recebem apenas dados declarados.

Ver [arquitetura/market-p2.md](./arquitetura/market-p2.md).

### P3 — OMS, executor e reconciliação genéricos

**Status:** CI/sim completo; adaptadores live implementados em 2026-07-20; **gate real ainda aberto**.

Entregáveis:

- [x] user channel sim e WebSocket autenticado real, normalização de order/trade e fallback REST;
- [x] heartbeat CLOB real com `heartbeat_id`, cancelamento remoto e `cancelAll` de emergência;
- [x] estados `CREATED`…`UNKNOWN` com transições validadas;
- [x] BUY/SELL GTC/FAK/FOK idempotentes com tick/min size (`marketRules.js`);
- [x] posição por instância + exposição agregada;
- [x] journal append-only + checkpoint/restore;
- [x] simulador determinístico (`createSimTransport`) como sink shadow/dry-run.

Gate de saída:

- [x] 100% das ordens shadow/dry-run têm estado final (testes);
- [x] fill parcial, evento duplicado e UNKNOWN reconciliados;
- [x] restart via checkpoint reconstrói posição antes de nova intenção;
- [x] strategy não acessa exchange order id (`getOrder` público).

Gate live adicional:

- [ ] User WS + REST reconciliam fills parciais e cancelamentos reais sem duplicar posição;
- [ ] heartbeat/cancel-on-disconnect comprovado no Giovanna;
- [ ] zero ordem remota sem intent/journal local.

Ver [arquitetura/oms-p3.md](./arquitetura/oms-p3.md).

### P4 — Risk, persistência e recovery da engine

**Status:** código endurecido em 2026-07-20; **recovery/preflight real ainda ops**.

Entregáveis:

- [x] pre-trade checks e limites locais/globais (notional, evento, conta, perda, rate, piso 4s);
- [x] geoblock/auth/clock/balance/allowance/live fail-closed; check ausente bloqueia live;
- [x] deadline revalidado em risk e executor; `REVERSE` live bloqueado sem saga;
- [x] circuit breaker, kill switch e shutdown com cancel de resting;
- [x] checkpoint/restore da engine + OMS journal + migrateState;
- [x] teste multi-instância com exposição agregada compartilhada.

Gate de saída:

- [x] falhas injetadas provam fail-closed;
- [x] cada bloqueio tem reason code + métrica de audit;
- [x] restore preserva posição sem duplicar intenção de entrada indevida;
- [x] limite global bloqueia segunda strategy quando a soma estoura.
- [ ] restart real com ordem aberta, partial fill e posição existente reconciliado antes de `ARMED`.

Ver [arquitetura/risk-p4.md](./arquitetura/risk-p4.md).

### P5 — Resiliência, observabilidade, deploy e gate Engine Ready

**Status:** código endurecido (2026-07-20); **ops Engine Ready ainda aberto** (soak ≥7d / Giovanna).

Entregáveis:

- [x] engine em processo/container próprio, separada da UI (`engine:serve`, `Dockerfile.engine`);
- [x] métricas (histogramas p50/p95/p99) + exposure/orphans via health;
- [x] logs estruturados com redaction e alertas operacionais;
- [x] backup do journal, checkpoint/rollback, health/ready/armed/live/halted;
- [x] testes de desconexão, restart, 401/429/503 e perda do user WS;
- [x] soak harness com fixtures (sem TFC) — `engine:soak`.
- [x] health/readiness falham com feed, recovery ou user WS indisponível;
- [x] checkpoint atômico e restore automático opcionais no processo da engine;
- [x] soak suporta duração real (`--duration-hours`) e intervalo entre ticks.

Gate de saída (código / CI):

- [x] fault injection sem órfãs (`test/observability-p5.test.js`);
- [x] control HTTP `/health` `/metrics` `/control/kill`;
- [x] engine aprovável com fixtures, sem importar TFC no core.

**Gate Engine Ready — ops, obrigatório antes de qualquer estratégia live:**

- [ ] soak ≥7 dias sem estado divergente não resolvido;
- [ ] restart, recovery, kill switch e rollback ensaiados em staging;
- [ ] zero ordem órfã e zero violação de risco no soak longo;
- [ ] SLOs e alertas validados no Giovanna;
- [x] engine aprovada sem depender de resultado, código ou comportamento da TFC.

Ver [arquitetura/observability-p5.md](./arquitetura/observability-p5.md).

### P6 — Plugin TFC V7 e paridade shadow

**Status:** código concluído (2026-07-19); shadow ≥100 eventos **reais** ainda ops.

Entregáveis:

- [x] TFC V7 pelo contrato genérico, sem SDK, env, rede ou filesystem;
- [x] estado próprio serializável; ordens/posição sob engine/OMS;
- [x] entrada, late flip exit/reverse 8→4s e danger exit em [4s, 5s);
- [x] paridade de volatilidade, `signedDistance`, preset e limites com o GLS (helpers + testes);
- [x] paridade sintética ≥100 casos no CI; [ ] shadow ≥100 eventos reais (ops).

Gate de saída:

- [x] diferença de intenção em replay sintético = 0;
- [x] testes cobrem limites UP/DOWN, tempo, spread, OBI, odds sum e velocity;
- [x] 0 decisão com feed stale;
- [x] suíte genérica de conformidade passa para TFC V7;
- [ ] mismatches de 100 eventos reais explicados (ops / Giovanna).

Ver [arquitetura/tfc-v7-p6.md](./arquitetura/tfc-v7-p6.md).

### P7 — Micro-live TFC de entrada

**Status:** harness e proteções de código concluídos (2026-07-20); **campanha live bloqueada** até os gates reais de P3–P5.

Entregáveis:

- [x] intenção em dry-run/shadow e entrada mínima com cap via engine (`tfc:micro-live`);
- [x] ordem/fill/cancel via `createLiveTransport` (mock no CI; CLOB real com `--live`);
- [x] relatório fee/slippage/órfã + paridade de intenção;
- [x] limite de canário independente do budget de $10 (`CANARY_LIMITS` + risk).

Gate de saída:

- [ ] pelo menos 10 entradas micro-live em dias distintos;
- [x] pipeline reconciliável sem órfã/duplicidade/violação de cap (testes mock);
- [ ] slippage/fee explicado em runs live reais;
- [x] nenhuma promoção só por aceite da ordem (relatório exige fill/reconcile).
- [x] resposta do POST não gera fill artificial; FAK é reconciliada por quantidade/preço reais;
- [x] finally executa cancelamento remoto e encerra heartbeats/feed.

Ver [arquitetura/micro-live-p7.md](./arquitetura/micro-live-p7.md).

### P8 — Saídas TFC: late flip, reverse e danger exit

**Status:** ausente.

O risk engine rejeita `REVERSE` em live com `LIVE_REVERSE_UNSUPPORTED` até esta fase implementar e validar a saga de duas pernas.

Ordem de validação:

1. monitorar posição e emitir intenção simulada;
2. micro SELL/exit entre 8s e 4s;
3. reverse com duas pernas e cap `lateFlipReverseMaxAsk=0.95`;
4. danger exit somente em [4s, 5s), com `k=0,3 × sigma(5s)`;
5. cancelamento protetivo no piso, sem ação tática nova abaixo de 4s.

Gate de saída:

- replay cobre flip, whipsaw, book vazio, partial fill, cap e janela perdida;
- 10 ocorrências shadow por mecanismo antes do primeiro live;
- cada micro-live é reconciliado sem ação abaixo do piso;
- PnL é atribuível a preço, fee, slippage e resolução.

### P9 — Canário e produção limitada

**Status:** bloqueado pelos gates reais ainda abertos de P3–P8.

Promoção progressiva:

1. shadow contínuo;
2. canário com budget fixo mínimo e no máximo 1 evento por janela de controle;
3. 25% do budget pretendido;
4. 50%;
5. budget V7 de $10 somente após revisão humana dos relatórios.

Gate de saída para cada degrau:

- mínimo de 50 eventos ou 7 dias, o que for maior;
- 0 violação de risco, ordem órfã ou divergência de posição;
- disponibilidade, p95/p99, slippage e erro dentro dos SLOs;
- perda e drawdown dentro do limite do canário;
- aprovação humana registrada e rollback pronto.

Escalar para $15–20 é uma decisão separada. O backtest mostrou eficiência ainda próxima de 90% em $20, mas drawdown cresce; isso não autoriza aumento antes de dados live suficientes.

## 7. Matriz de verificação

| Camada | Unitário | Integração | Replay/shadow | Micro-live |
|---|---|---|---|---|
| Engine/contrato | schemas/conformidade | registry + journal | strategy fake/restart | mesmo pipeline, sink live |
| Config/auth | parsing/redaction | derive + saldo + geoblock | startup fail-closed | smoke sem ordem |
| Feed/book | normalização/gaps | reconnect/resync | ≥100 eventos | comparação com UI |
| TFC V7 | gates e janelas | preset sync | paridade com GLS | intenção vs execução |
| OMS | transições/idempotência | WS + REST + journal | falhas injetadas | partial/fill/cancel |
| Risk | todos os bloqueios | kill switch/heartbeat | soak | limites mínimos |
| Recovery | checkpoint/replay | restart/timeout | chaos controlado | ordem/posição existente |

## 8. Definition of Done para produção

O robô só pode ser chamado de produção quando:

- P0–P9 tiverem gates aprovados e evidência versionada;
- strategy version, preset e commit estiverem presentes em toda decisão;
- ordem e posição forem recuperáveis após restart;
- user WS, REST e journal forem reconciliados;
- limites de risco, geoblock, heartbeat e kill switch estiverem ativos;
- dashboards/alertas distinguirem `healthy`, `ready`, `armed`, `live` e `halted`;
- houver runbook de incidente, rollback testado e responsável de plantão definido;
- uma UI indisponível não afetar a engine, e uma engine não pronta não parecer operacional só porque a UI responde.

## 9. Riscos ainda abertos

| Risco | Impacto | Mitigação no plano |
|---|---|---|
| Paridade live/backtest imperfeita | Estratégia diferente da validada | P1/P2: trace diferencial e preset sync |
| Consistência eventual de ordens | Duplicidade ou estado incorreto | P3: user WS + polling + idempotência |
| Book/spot stale na janela terminal | Entrada no lado/preço errado | P2/P4: watchdogs fail-closed |
| Fill parcial no exit/reverse | Exposição residual | P3/P6: OMS por quantidade e reconciliação das pernas |
| Latência/jitter | Perda da janela 8→4s | p95/p99 no Giovanna e piso rígido de 4s |
| Mudança de API/fee/mercado | Modelo financeiro incorreto | contract tests e consulta por mercado |
| Região bloqueada do host | Ordens rejeitadas / não conformidade | geoblock preflight no host efetivo |
| Vazamento de credenciais | Perda financeira | secrets server-side, redaction e rotação ensaiada |

## 10. Referências oficiais

- [Order types e post-only](https://docs.polymarket.com/trading/orders/overview)
- [Ciclo de vida das ordens](https://docs.polymarket.com/concepts/order-lifecycle)
- [Fees e maker rebates](https://docs.polymarket.com/trading/fees)
- [WebSocket de usuário](https://docs.polymarket.com/market-data/websocket/user-channel)
- [Heartbeat / cancel-on-disconnect](https://docs.polymarket.com/api-reference/trade/send-heartbeat)
- [Restrições geográficas](https://docs.polymarket.com/api-reference/geoblock)
