# Plano de desenvolvimento — Data Robot

**Revisado em:** 22/07/2026  
**Estado atual:** engine + UI no Giovanna; **ainda não** é robô autônomo. Canário deste ciclo = **só MIDAS $1**.  
**URL oficial:** https://robot.fracta.online  
**Pacote:** `data-robot` **1.10.0**  
**Estratégia deste ciclo:** MIDAS Carry V1 (`midas-carry-v1` / preset lab `btc-champion-v1`). Plugin **implementado** no robot (CI); **shadow ≥5 ENTER OK** (22/07); micro-live $1 ainda aberto.  
**Depois:** qualquer estratégia via o mesmo contrato (engine agnóstica). TFC V7 = helpers no código, fora do canário agora.

Este é o roadmap canônico. O [runbook TFC](./tfc-validacao-real.md) é baseline histórico do plugin TFC — **não** define a trilha MIDAS deste ciclo.

## 1. Objetivo e limites

Entregar uma engine de trading real, segura e independente de estratégia, inicialmente validada em mercados BTC Up/Down de 5 minutos na Polymarket, que:

- execute estratégias por um contrato estável, sem acoplá-las ao SDK, credenciais, OMS ou infraestrutura;
- disponibilize um catálogo explícito de plugins aprovados, começando por TFC V7 como referência implementada e **MIDAS Carry V1** como candidata à promoção, ambas com paridade verificável em relação ao `data-backtest`;
- não opere quando dados, conta, mercado ou controles de risco estiverem inválidos;
- conheça o ciclo de vida das próprias ordens e posições mesmo após falhas ou reinício;
- possa ser promovido de replay para shadow, micro-live e produção por gates mensuráveis;
- produza evidência suficiente para explicar cada decisão e reconciliar PnL, fills e fees.

Ficam fora deste ciclo:

- descoberta ou otimização de estratégia, que pertencem ao `data-backtest`;
- processos **multi-live** na mesma conta sem OMS/risk/recovery globais e duráveis; BTC 5m e ETH 5m simultâneos são suportados pelo alvo arquitetural, enquanto estratégias concorrentes no mesmo mercado exigem política adicional de conflito/netting;
- execução com dinheiro de terceiros;
- decisões táticas abaixo do piso de 4 segundos, exceto cancelamento protetivo.

## 2. Decisões corrigidas nesta revisão

1. **Agora o teste/canário é só MIDAS; a engine continua strategy-agnostic.** Depois qualquer plugin aprovado (TFC, Apex, etc.) entra pelo mesmo contrato/catálogo. TFC V7 hoje é só referência de código (helpers/núcleo Danger Floor), sem smoke nem canário neste ciclo. Preset MIDAS `btc-champion-v1` em `midas-carry-v1/presets/` — não confundir com preset TFC homônimo. Plugin MIDAS ainda só no lab (`data-backtest`).
2. **V7 substitui V6 como baseline de execução.** A V6 Hybrid depende de stop-buy sintético. A validação do backtest concluiu que esse mecanismo pode disparar na zona abaixo de 4s, onde o book e a latência não sustentam execução fiel.
3. **F4 não implementará hedge stop da V6.** A sequência correta é late flip exit/reverse da V7/MIDAS e, depois, danger exit no piso de 4s.
4. **Engine contínua já está no Giovanna (A1/A2).** `data-robot-engine` `:3201` em shadow/fixture com drills OK. Faltam plugin MIDAS, evidência live MIDAS e soak ≥4h (bg).
5. **A UI estática não é o robô.** `npm start` serve somente `public/`. URL oficial da UI: https://robot.fracta.online. A engine deve ser um processo separado (`:3201`), sem secrets no frontend.
6. **A latência média/mediana não basta.** Promoção exige p95/p99 por operação, visibilidade da ordem, taxa de erro e comportamento sob timeout.
7. **REST imediato não é confirmação suficiente.** O canal WebSocket autenticado de usuário deve ser a fonte primária de eventos de ordem/trade; REST será usado para reconciliação.
8. **Maker não significa apenas fee zero.** Maker não paga fee de protocolo e pode receber rebate. A hipótese local de maker ainda precisa de um fill real para ser considerada validada.
9. **O medidor de latência exige `--live`.** Sem a flag, o comando recusa (exit 2) e cancela em `finally` quando a ordem foi criada.
10. **A engine vem antes e independe da estratégia.** Core, OMS, risk, persistência, recovery e observabilidade não podem importar MIDAS/TFC. Plugins aprovados entram por allowlist no composition root; disponibilidade não implica ativação live.
11. **“Código concluído” não equivale a “gate live aprovado”.** P3–P7 distinguem explicitamente CI/simulação de evidência real no Giovanna.
12. **POST de ordem é somente ACK.** Fill e preço executado vêm do user WS ou de reconciliação REST; FAK pode preencher parcialmente.
13. **REVERSE permanece bloqueado em live.** A promoção exige saga persistida `SELL → reconcile → BUY`, não uma compra isolada do lado oposto.
14. **Catálogo ≠ ativação; conta compartilhada ≠ estado isolado.** Todos os plugins aprovados podem ficar disponíveis. BTC 5m e ETH 5m podem operar simultaneamente como instâncias distintas, mas devem compartilhar coordenação global e durável de saldo, risk, OMS e recovery. Estratégias concorrentes no mesmo mercado permanecem bloqueadas sem arbitragem. Ver [ADR-002](./arquitetura/adr-002-strategy-catalog-supervision.md).

## 3. Diagnóstico do estado atual

| Área | Estado | Evidência / lacuna |
|---|---|---|
| Auth L1/L2, signer, funder | Código endurecido; ops aberto | `runLivePreflight` valida auth, identidade, saldo/allowance, relógio, geoblock e ausência de ordens abertas. Falta evidência repetida no serviço do Giovanna. |
| Descoberta BTC 5m e PTB | Feito no código; ops aberto | Runner contínuo com retry observável, `acceptingOrders` fail-closed e testes de rotação/transição; falta evidência contínua no Giovanna. |
| ETH 5m | Arquitetura compatível; adapters/plugins ausentes | Exige descoberta/normalização do mercado ETH 5m e plugin aprovado com `supportedMarkets`; reutiliza engine, account risk, OMS e control plane. |
| RTDS e CLOB market feed | Feito (P2) | Normalização, staleness, hub e source contínua com shutdown sem reconexão residual. |
| Engine / contrato de estratégia | Feito (P1+P6 TFC + MIDAS) | Runtime + registry + fixtures + `tfc-v7` + **`midas-carry-v1`**. |
| Catálogo / supervisão | Registry básico feito; evolução pendente | Plugins já são selecionáveis por `strategyId`; faltam estados de aprovação, `marketScope`, deployment config e supervisor. Multi-mercado live exige coordenador global da conta. |
| Gates de entrada | Feito (P6 TFC) | `evaluateEntryGates` + late flip + danger exit no plugin TFC; MIDAS reusa + tier. |
| Preset de produção | MIDAS pendente no robot | Lab MIDAS: `midas-carry-v1/presets/btc-champion-v1.json`. Robot ainda alinha `watch`/`micro-entry` ao `btc-champion-v7`. |
| Entrada real | Feito (P7 código TFC) | `tfc:micro-live` via engine + canary cap; campanha live bloqueada até P3–P5; MIDAS harness ainda inexistente. |
| Saída / reverse / danger exit | Sinais no plugin TFC; execução live ausente | Plugin já emite late flip / danger EXIT. P8 = ciclo live reconciliado. `REVERSE` live bloqueado até saga. |
| OMS e user WebSocket | Código live implementado; ops aberto | User WS autenticado, heartbeat CLOB, reconciliação por ordem e detecção de órfãs; validação real prolongada ainda pendente. |
| Risco e kill switch | Código endurecido; ops aberto | Preflight live obrigatório, deadlines, caps, kill/circuit e `REVERSE` bloqueado até P8. |
| Persistência / recovery | Código + drill shadow aprovados | Volume persistente no Giovanna; 2 restarts e restart pós-kill preservaram checkpoint e posição shadow. Ensaio com ordem/posição real permanece para o OMS smoke. |
| Observabilidade | Código endurecido; ops aberto | Readiness depende de feed/recovery/user WS; métricas ausentes reprovam SLO; calibragem Giovanna pendente. |
| Testes e CI | Feito | `npm run ci` (lint + architecture + testes); sem rede/ordens reais. |
| Deploy | UI + engine no ar | UI em https://robot.fracta.online; engine `:3201` separada, interna, `running:healthy` em `shadow + fixture`. Falta soak ≥4h; soak longo só para P9. |

### O que vamos seguir (sequência definitiva deste ciclo)

```text
FEITO:  engine Giovanna + drills (A1/A2)
        plugin MIDAS + CI + midas:micro-live (B código)
        Shadow MIDAS ≥5 ENTER (22/07 Giovanna)
          → docs/operacao/evidencia-midas-shadow-2026-07-22.md
          │
AGORA:  3) 1º micro-live MIDAS US$ 1  →  +2 micros
          │
META:   Produção canário = enter/hold $1 repetível (3 runs OK)
          │
DEPOIS: EXIT/danger live → só então subir budget / P9
          │
FUTURO: outras estratégias no mesmo contrato (TFC, Apex, …)
```

| # | Fazer | Não fazer ainda |
|---|--------|-----------------|
| ✓ | Plugin `midas-carry-v1` + paridade ≥100 + `midas:micro-live` | Smoke/canário TFC |
| ✓ | Shadow ≥5 ENTER (22/07) | Exigir shadow 100 / 7 dias |
| 3 | 3 micros $1 reconciliados | UI dashboard, login real |
| 4 | EXIT live antes de subir $ | REVERSE, ETH, catálogo ADR-002 completo |

**Produção canário** = MIDAS real, cap **$1**, ENTER→fill→hold até o fim do evento, com preflight/WS/reconcile/kill.  
**Não** é autonomia 24/7 nem budget do backtest ($10).

**bg:** soak engine ≥4h (não bloqueia 1–3).

### Próximos passos — detalhe

**Alvo deste ciclo:** só **MIDAS Carry V1**. TFC V7 = referência de código; fora de smoke/shadow/canário.

**Feito:** A1/A2 (engine healthy + drills).

| Ordem | Fase | O quê | Critério |
|------:|------|--------|----------|
| **1 — código ✓** | **B** | Plugin MIDAS + paridade CI + harness `midas:micro-live` | registry + ≥100 sintéticos + script (CI verde 22/07) |
| **2 — ✓** | **C'** | Shadow MIDAS curto | ≥5 ENTER (22/07 Giovanna); [evidência](./operacao/evidencia-midas-shadow-2026-07-22.md) |
| **3** | **E1** | 1º micro-live MIDAS $1 | fill/reconcile ou cancel limpo |
| **4** | **E2** | +2 micros ($1) | 3 reconciliados, 0 órfã → **canário enter/hold** |
| **5** | **F'** | EXIT/danger live | antes de subir budget |
| **6** | **G** | P9 + outras estratégias | depois do canário MIDAS estável |

**Obrigatório em qualquer live MIDAS:** preflight, canary **$1**, ACK≠fill, User WS/REST, cancel/finally, kill.

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
adapters de mercado ──► market hub / snapshots por marketScope
                                      │
approved catalog ─► deployment ─► strategy supervisor
                                      │
                         ┌────────────┴────────────┐
                         ▼                         ▼
                  instance BTC 5m          instance ETH 5m
                         └────────────┬────────────┘
                                      │ trade intents
                                      ▼
                         account risk coordinator
                                      │ aprovado
                                      ▼
                         OMS + execution adapter
                           │                    │
                           ├── CLOB REST        └── user WebSocket
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
| `engine` | Ciclo de vida de uma instância e roteamento de eventos/intenções | Conhecer regras TFC/MIDAS ou chamar SDK diretamente |
| `approved catalog` | Allowlist de plugins, versões, capabilities e presets permitidos | Ativar plugin apenas porque está registrado |
| `strategy deployment` | Declarar instância, `marketScope`, preset, modo e aprovação | Esconder troca de versão/preset |
| `strategy supervisor` | Distribuir snapshots e supervisionar instâncias isoladas | Decidir sinal ou manter capital global só em memória local |
| `strategy/*` | Transformar contexto normalizado em intenção determinística e estado serializável | Chamar SDK/API, ler `.env`, gravar arquivo ou controlar risco global |
| `account risk coordinator` | Aceitar/rejeitar intenção por limites locais e globais da conta | Inventar sinal ou reservar o mesmo saldo duas vezes |
| `oms` | Idempotência e estados de ordem/fill/cancel | Alterar parâmetros da estratégia |
| `executor` | Traduzir intenção para GTC/FAK/FOK com cap explícito | Presumir fill pela resposta de POST |
| `journal` | Registrar eventos append-only e checkpoints | Armazenar secrets |
| `reconciler` | Comparar journal, user WS, REST, saldo e posições | Silenciar divergência |
| `control plane` | Start/stop, dry-run/live, kill switch, health/readiness | Servir chave privada ao browser |

### Contrato de estratégia

A engine não deve ter um `if (strategy === 'tfc')`. O composition root mantém uma allowlist e o deployment seleciona plugin, preset e mercado explicitamente. `marketScope` pertence à instância (`btc-updown-5m`, `eth-updown-5m` etc.), deve constar em `manifest.supportedMarkets` e não pertence à lógica genérica do core.

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

1. A engine faz preflight e recovery da conta; o catálogo valida plugins/versões e o deployment declara instâncias aprovadas.
2. Market/feed adapters publicam snapshots normalizados por `marketScope`.
3. O supervisor entrega somente snapshots compatíveis, posição e estado a cada instância.
4. Cada estratégia devolve novo estado, diagnósticos e zero ou mais intenções; não envia ordens.
5. O account risk coordinator valida health, limites da instância/mercado/conta, idempotência e compliance.
6. OMS/executor converte intenção aprovada em ordem e acompanha ACK, partial fill, fill, cancel ou estado desconhecido.
7. User WS/REST geram eventos de execução; a engine atribui por instância, atualiza posição/journal e devolve o evento ao plugin correto.
8. Restart reconstrói conta, OMS e todas as instâncias pelo journal antes de aceitar nova intenção.

Para adicionar outra estratégia, implementa-se esse contrato, seu preset/schema e os testes de conformidade. OMS, risk, feeds básicos, journal, recovery, deploy e observabilidade permanecem os mesmos. Se a nova estratégia exigir outro mercado ou dado, adiciona-se um adapter/capability reutilizável — não uma segunda engine.

Disponibilidade e concorrência são decisões separadas. Vários plugins podem permanecer no catálogo; BTC 5m e ETH 5m podem rodar juntos como instâncias isoladas quando compartilham coordenação global da conta. Duas estratégias no mesmo mercado/evento exigem arbitragem de conflito/netting. Ver [ADR-002](./arquitetura/adr-002-strategy-catalog-supervision.md).

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
- Toda instância declara `marketScope`; ordem, posição, journal e checkpoint são atribuídos por `strategyInstanceId + marketId`.
- Instâncias live na mesma conta, inclusive BTC 5m + ETH 5m, compartilham reserva atômica de saldo, exposição/perda global, rate limits e kill switch.
- Processos live independentes não podem usar a mesma conta enquanto o coordenador global não for durável e comum a todos.
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
- [ ] coordenador global durável reserva capital sem corrida entre instâncias BTC/ETH antes de liberar multi-mercado live.

Ver [arquitetura/risk-p4.md](./arquitetura/risk-p4.md).

### P5 — Resiliência, observabilidade, deploy e gate Engine Ready

**Status:** código endurecido (2026-07-20); **ops Engine Ready ágil** ainda aberto no Giovanna. Soak ≥7d passou a ser gate de **P9 / canário contínuo**, não bloqueio do primeiro micro-live.

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

**Gate Engine Ready ágil — ops, suficiente para micro-live canário ($1):**

- [x] engine `:3201` no Giovanna com `/health` e `/ready` OK;
- [ ] soak contínuo **≥4h** (ideal 24h) com fixtures **ou** shadow, sem divergência não resolvida;
- [x] drills no mesmo dia: ≥2 restarts, 1 kill switch e restore de checkpoint; não havia resting para cancelar;
- [x] zero órfã e zero violação de risco nos drills;
- [x] engine aprovada sem depender de resultado, código ou comportamento da TFC/MIDAS.

**Gate Engine Ready longo — só para P9 / operação contínua:**

- [ ] soak ≥7 dias sem estado divergente não resolvido;
- [ ] SLOs e alertas calibrados no Giovanna em janela longa.

**Gate supervisor / multi-mercado live:**

- [ ] catálogo e deployments registram versão, preset, `marketScope`, modo e aprovação;
- [ ] BTC 5m + ETH 5m compartilham account risk/OMS/recovery sem misturar posição ou journal;
- [ ] falha/kill por instância e kill global ensaiados;
- [ ] nenhuma reserva dupla de saldo sob intenções concorrentes;
- [ ] estratégias concorrentes no mesmo mercado continuam bloqueadas até existir arbitragem explícita.

Ver [arquitetura/observability-p5.md](./arquitetura/observability-p5.md).

### P6 — Plugins aprovados e paridade shadow

**Status:** infraestrutura genérica e plugin TFC V7 concluídos; MIDAS ainda ausente. Cada combinação plugin + versão + preset percorre gate próprio.

Entregáveis:

- [x] TFC V7 pelo contrato genérico, sem SDK, env, rede ou filesystem;
- [x] estado próprio serializável; ordens/posição sob engine/OMS;
- [x] entrada, late flip exit/reverse 8→4s e danger exit em [4s, 5s);
- [x] paridade de volatilidade, `signedDistance`, preset e limites com o GLS (helpers + testes);
- [x] paridade sintética ≥100 casos no CI; [ ] shadow sprint ≥20 eventos reais (ágil); [ ] shadow ≥100 (promoção P9).
- [ ] MIDAS Carry V1 implementada pelo mesmo contrato, sem alterar core/OMS/risk;
- [ ] preset MIDAS `btc-champion-v1` (path `midas-carry-v1/presets/`) versionado e paridade sintética contra o `data-backtest`;
- [ ] MIDAS shadow sprint ≥20 eventos reais com mismatches explicados; [ ] ≥100 antes de canário contínuo.

Gate de saída:

- [x] diferença de intenção em replay sintético = 0;
- [x] testes cobrem limites UP/DOWN, tempo, spread, OBI, odds sum e velocity;
- [x] 0 decisão com feed stale;
- [x] suíte genérica de conformidade passa para TFC V7;
- [ ] mismatches de shadow sprint (≥20) explicados para liberar wave-1 micro-live;
- [ ] mismatches de 100 eventos reais explicados para cada plugin candidato antes de P9;
- [ ] status `shadow-approved` (sprint) e depois `canary-approved` registrados por versão + preset; aprovação de TFC não promove MIDAS nem vice-versa.

Ver [arquitetura/tfc-v7-p6.md](./arquitetura/tfc-v7-p6.md).

### P7 — Micro-live de entrada por plugin

**Status:** harness TFC e proteções genéricas concluídos (2026-07-20); nenhuma estratégia tem campanha live aprovada. MIDAS precisa de composition/harness próprio ou parametrização do canário genérico.

Entregáveis:

- [x] intenção em dry-run/shadow e entrada mínima com cap via engine (`tfc:micro-live`);
- [x] ordem/fill/cancel via `createLiveTransport` (mock no CI; CLOB real com `--live`);
- [x] relatório fee/slippage/órfã + paridade de intenção;
- [x] limite de canário independente do budget de $10 (`CANARY_LIMITS` + risk).
- [ ] canário recebe `strategyId`, versão, preset e `marketScope` aprovados sem bootstrap específico hard-coded;

Gate de saída (trilha ágil → promoção):

- [ ] **wave-1:** ≥3 entradas micro-live reconciliadas (cap canário) **por plugin + preset** — libera aprendizado live;
- [ ] **promoção:** ≥10 entradas em dias distintos antes de canário contínuo / P9;
- [x] pipeline reconciliável sem órfã/duplicidade/violação de cap (testes mock);
- [ ] slippage/fee explicado em runs live reais;
- [x] nenhuma promoção só por aceite da ordem (relatório exige fill/reconcile).
- [x] resposta do POST não gera fill artificial; FAK é reconciliada por quantidade/preço reais;
- [x] finally executa cancelamento remoto e encerra heartbeats/feed.

Ver [arquitetura/micro-live-p7.md](./arquitetura/micro-live-p7.md).

### P8 — Saídas por plugin: exit, reverse e danger exit

**Status:** ausente.

O risk engine rejeita `REVERSE` em live com `LIVE_REVERSE_UNSUPPORTED` até esta fase implementar e validar a saga genérica de duas pernas. Regras de sinal continuam no plugin; execução, reconciliação e exposição residual pertencem à engine/OMS.

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
5. budget aprovado do preset candidato somente após revisão humana dos relatórios.

Gate de saída para cada degrau:

- trilha ágil até budget mínimo: evidência da wave-1 + Engine Ready ágil;
- degraus P9: mínimo de 50 eventos **ou** 7 dias (o que for maior) — calendário longo só aqui;
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
| Plugin de estratégia | contrato, gates e janelas | catálogo + preset sync | paridade por versão/preset | intenção vs execução |
| Supervisor | roteamento por scope | risk/OMS globais | BTC + ETH isolados | concorrência sem reserva dupla |
| OMS | transições/idempotência | WS + REST + journal | falhas injetadas | partial/fill/cancel |
| Risk | todos os bloqueios | kill switch/heartbeat | soak | limites mínimos |
| Recovery | checkpoint/replay | restart/timeout | chaos controlado | ordem/posição existente |

## 8. Definition of Done para produção

O robô só pode ser chamado de produção quando:

- P0–P9 tiverem gates aprovados e evidência versionada;
- strategy version, preset e commit estiverem presentes em toda decisão;
- catálogo registrar aprovação por plugin + versão + preset, sem ativação implícita;
- instâncias multi-mercado compartilharem coordenação global da conta e preservarem isolamento por `strategyInstanceId + marketId`;
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
