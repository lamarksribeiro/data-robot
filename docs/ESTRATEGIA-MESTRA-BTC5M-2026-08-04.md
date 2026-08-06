# Estratégia mestra BTC 5m — E-Golden Defense-First (V2)

**Data:** 2026-08-05 (revisão V2)  
**Status:** `RESEARCH / SHADOW-READY`; não é autorização para operar dinheiro real.  
**Executor escolhido para o próximo teste:** `scripts/binance-lead-scalp/` — variante `e-golden` **V2** (`impulseCap=20`, `rescueStop=0.25`).  
**Spec consolidada:** `data-backtest/docs/estrategias/estrategia-definitiva-btc-5m-golden-v2-2026-08-05.md`.  
**Objetivo:** testar uma única hipótese econômica com ataque, execução e defesa inseparáveis.

## 1. Decisão executiva

Vamos testar primeiro o **Binance-lead directional scalp**, em uma única perna UP ou DOWN, com:

- sinal de impulso do BTC na Binance antecipando o book de 5 minutos;
- limiar adaptativo `clamp(2.5σ, $5, $20)` (V2 — mais seletivo que o cap $12);
- entrada agressiva somente quando o ask, o spread, a idade do book e a liquidez passam pelos filtros;
- `sharesCap@0.50` para impedir que ask barato transforme o mesmo orçamento em uma posição grande demais;
- saída maker em `entry + $0.08` e `entry + $0.14`, dividida 50/50;
- resgate maker em `entry + $0.01` depois de stop/timeout leve;
- **corte imediato taker** se o bid já estiver em `entry - $0.25` (V2);
- reconciliação de cada fill real e circuit breaker fail-closed.

O teste inicial é **$5 de orçamento por entrada**, com teto de 10 shares, teto de $40 de notional por sessão e perda máxima de $8 por sessão. Esses limites são envelope de teste; não devem ser ampliados por performance bonita de uma amostra curta.

Não vamos transformar isto em um robô que promete dinheiro. A “máquina de guerra” é o conjunto fechado abaixo: uma hipótese de ataque que sobreviveu melhor às análises disponíveis, mais um sistema que sabe não entrar, sair, parar e reconciliar quando a hipótese ou a infraestrutura falham.

## 2. O que é fato, hipótese e desconhecido

- **[MEDIDO]** é número observado em relatório/replay específico.
- **[INFERIDO]** é conclusão de engenharia a partir de vários resultados.
- **[DESCONHECIDO]** ainda precisa de shadow, prints, fila, latência ou fill real.

### Candidato principal

| Componente | Evidência disponível | Leitura correta |
|---|---:|---|
| `full-adapt-rescue-ds15`, budget $10, sem cap | 52.030 trades, WR 74,5%, PnL +$50.687,65, PF 3,062, DD $126,85 | **[MEDIDO]** edge de replay, mas expõe cauda grande quando ask barato gera shares demais |
| `cap50`, budget $10 | PnL +$36.954,53, PF 3,121, DD $88,75 | **[MEDIDO]** sacrifica PnL nominal e melhora cauda/DD; é a base defensiva |
| `aud-golden-b5-ds15`, budget $5 | PnL +$19.240, PF 3,18, DD $42,62, WR 75,0% | **[MEDIDO]** paper auditado, ainda com proxy de fill maker |
| `aud-golden-b5-ds25`, budget $5 | PnL +$20.076,71, PF 3,66, DD $32,22, WR 76,8% | **[MEDIDO]** V1 challenger; aceita perda por share maior |
| **`aud-golden-v2-c20-b5-ds25`** | PnL +$20.095, PF **4,71**, DD **$14,26**, WR **80,4%** | **[MEDIDO]** **default V2** — mesmo PnL, DD −56% vs V1 |
| `aud-golden-v2-c20-b10-ds25` | PnL +$38.631, PF 4,63, DD $28,51, WR 80,2% | **[MEDIDO]** escala paper; só após micro validado |
| Micro forense budget $3 | PnL -$1,20 em 2 trades: +$0,35 e -$1,55 | **[MEDIDO]** mostrou o defeito operacional: ask barato + gap de desastre |

O replay mostra uma relação importante: o ganho vem de muitos `ladder_full`/`rescue_full` e WR alta; o desastre individual pode ser maior que o win típico. Portanto, o ataque sem cap não é a estratégia; é somente o experimento que revelou o sinal.

## 3. Linhas que ficam fora do executor

| Linha | Decisão | Motivo |
|---|---|---|
| Complete-set / UP+DOWN | **Rejeitada** | snapshots `ask_UP + ask_DOWN < 1` são alarme de integridade; em 8.798 eventos a estratégia ingênua perdeu -$42.762,72 e o zero-fee ainda não criou edge |
| Pair-Path / passive pair / clip | **Rejeitada** | 99 dias, 25.269 eventos, EV -$0,0496/share com IC95 negativo |
| SHOTANDGO / Phil 1.0 | **Rejeitada** | replay honesto negativo; melhor variante reportada PnL -$1.236,74 e PF 0,6989; cauda/exposição também falharam |
| TSC | **Hipótese isolada** | o full sample foi positivo, mas decaiu para perto de zero em julho; precisa de shadow atual e evidência de latência/fill |
| Hyperion antigo | **Rejeitado como campeão** | variantes históricas ficaram negativas ou próximas de PF 1; nomes “champion” não equivalem a validação |
| Apex / janelas curtas | **Não promover** | resultados instáveis e amostras curtas |
| Midas `btc-gold-v1` | **Shadow separado** | full May–Jul: +$6.439,24, 7.694 entradas, PF 1,527, DD $90,84; candidato interessante, mas não deve ser misturado ao scalp até provar proteção e execução |
| `src/strategy/hyperionGoldV1.js` atual | **Não usar como executor** | não implementa de fato a união low-ask + high-ask; a fração de saída de 50% é ignorada e o `dangerExit` do preset não está implementado |

Nenhuma linha secundária pode compartilhar posição, saldo, limites ou decisão de risco com o candidato principal antes de ser validada isoladamente.

## 4. Ataque: especificação canônica

### 4.1 Dados e identidade

1. Consumir **Binance WS** para o spot BTC e **CLOB WS** para o book do token.
2. Associar cada evento por identidade canônica: `event_id`, `condition_id`, token UP/DOWN e janela temporal correta.
3. Rejeitar book stale, crossed, sem bid/ask utilizável, com timestamp incoerente ou com reconexão ainda não aquecida.
4. Usar `ask_UP + ask_DOWN < 1` como **alarme de feed/paridade**, nunca como permissão automática de arbitragem.
5. No replay, confirmar cobertura real do lake e do manifesto. Existe divergência histórica entre janela reportada até 31/07 e inventário que terminava em 26/07; uma janela sem cobertura comprovada não é OOS.

### 4.2 Sinal Binance-lead

Para cada tick elegível:

```text
lead2s = BTC[t] - BTC[t-2s]
sigma  = desvio-padrão(lead2s, janela de 300s)
thr    = clamp(2.5 * sigma, $5, $20)   # V2: cap $20 (antes $12)
       = $8 quando sigma ainda não é utilizável
lado   = UP se lead2s > 0; DOWN se lead2s < 0
```

Entrar somente se `abs(lead2s) >= thr` e se o tempo restante do evento estiver entre **20s e 280s**. Não elevar `minTau` para 60s: o A/B disponível cortou aproximadamente 8,8% do PnL no replay.

### 4.3 Filtros do book

- ask do lado escolhido: **$0,15 a $0,70**;
- spread: **até $0,04**;
- movimento de mid stale: **até $0,03**;
- ask size disponível: pelo menos `0,75 × shares planejadas`;
- mínimo operacional: 5 shares;
- uma única direção por decisão; não comprar a perna oposta para “neutralizar” o trade;
- uma entrada só após o cooldown e sem posição/orphan/order pendente do evento anterior.

Se qualquer filtro estiver ausente, inconsistente ou atrasado, a decisão é `NO_TRADE`, não uma aproximação otimista.

### 4.4 Sizing e entrada

Configuração canônica inicial:

```text
budget        = $5
sharesCapAsk  = $0.50
shares        = min(budget / ask, floor(budget / 0.50))
max shares    = 10
```

O cap é deliberadamente assimétrico: com ask de $0,20, o robô não compra 25 shares; fica limitado a 10. O orçamento é teto, não obrigação de gastar $5.

A entrada é **FAK/taker** no ask observado, com o preço máximo/slippage definido pelo executor. O resultado da entrada é a quantidade efetivamente `MATCHED`; rejeição, fill parcial e cancelamento precisam ser registrados como tais. Nunca contabilizar o restante como posição.

Durante a primeira fase de shadow, manter a mesma lógica do replay e também registrar a variante conservadora de no máximo uma entrada por evento. Não escolher a melhor retrospectivamente.

### 4.5 Monetização

Depois do fill real:

1. Dividir a posição em duas ordens maker GTC/post-only, 50% em `entry + $0,08` e 50% em `entry + $0,14`.
2. Confirmar `size_matched` e preço de cada ordem por reconciliação; status `FILLED` sozinho não basta.
3. Só creditar taxa maker zero quando o próprio wallet/activity/trader side comprovar o fill maker. No replay, `bid >= limit` é apenas proxy de fill, não prova de fila.
4. Se uma ordem tiver menos que o mínimo negociável, consolidar o residual em uma ordem válida; nunca deixar saldo órfão por dividir em pedaços inválidos.

## 5. Defesa: máquina de estados

```text
FLAT
  -> ARMED
  -> ENTERING
  -> OPEN
  -> LADDER_MAKER
  -> RESCUE_MAKER
  -> FLATTENING
  -> RECONCILED

qualquer estado + fill incerto/orphan/feed inválido
  -> CIRCUIT_OPEN -> cancelar -> flatten -> reconciliar -> parar
```

### 5.1 Antes da entrada

- confirmar saldo reservado, wallet/chain e token corretos;
- `cancelAll`/reconciliação sem ordens vivas inesperadas;
- confirmar que não há posição aberta no evento nem orphan de sessão anterior;
- confirmar relógio, sequência/idade do book e conexão Binance/CLOB;
- registrar hash/configuração da sessão;
- bloquear entrada se o circuit breaker estiver aberto.

### 5.2 Stop leve e resgate

Enquanto a posição estiver sem desastre:

- se `bid <= entry - $0,05`, ou `hold >= 20s`, cancelar a ladder restante;
- postar o residual como ask maker em `entry + $0,01` somente se o book continuar saudável;
- marcar estado `RESCUE_MAKER` e não continuar criando novas entradas;
- no resgate, aceitar apenas fill real, stop de desastre ou flatten de fim de evento.

O resgate não é uma licença para segurar até zero. `rescueStop=0` fica proibido no teste com dinheiro real e não pode ser usado para apresentar PF bonito.

### 5.3 Desastre

Se em qualquer tick `bid <= entry - $0,25`:

1. cancelar ladder/rescue pendentes;
2. não postar rescue maker inútil em um gap já aberto;
3. executar dump residual FAK/taker com retries e proteção de erro;
4. se não houver bid executável, entrar em `CIRCUIT_OPEN`, tentar a rota de flatten definida pelo executor e marcar o caso como incidente, não como lucro/perda “normal”.

O corte de $0,25 (V2) é defesa contra a assimetria observada, com menos dumps prematuros que o ds15. Não é garantia de perda máxima: slippage, book vazio, atraso e falha de transporte podem piorar o resultado e precisam aparecer no relatório.

### 5.4 Fim de evento, shutdown e reconciliação

- cancelar todas as ordens maker;
- vender todo residual com rota de flatten;
- reconciliar CLOB, activity/trade history e saldo do wallet;
- só então fechar o evento e liberar o próximo;
- `SIGTERM`, erro de conexão ou exceção crítica seguem a mesma rotina;
- qualquer quantidade não explicada mantém o circuito aberto e impede restart automático.

### 5.5 Limites da sessão

Envelope inicial, sem autoaumento:

| Limite | Valor |
|---|---:|
| orçamento por entrada | $5 |
| shares máximas por entrada | 10 |
| notional máximo da sessão | $40 |
| perda máxima da sessão | $8 |
| eventos no micro-teste | 8 |
| book age máximo | 1.200 ms |
| posições simultâneas | 1 |
| reentrada após `rescue_stop` | 0 |

Ao atingir qualquer limite, parar a sessão. Não “recuperar” prejuízo aumentando o size, trocando o lado, removendo o stop ou reabrindo automaticamente.

## 6. Paridade que ainda precisa ser fechada

O código local `VARIANT_E_GOLDEN` já contém `sharesCap`, `impulseCap=20`, `rescueStop=0.25` e pre-dump (V2, 05/08); os testes unitários atuais passaram. Isso demonstra comportamento de unidade, não edge econômico.

Antes de qualquer promoção, corrigir/confirmar:

1. **Paridade lab ↔ engine ↔ dry ↔ live:** lab V2 (`aud-golden-v2-c20-b5-ds25`) e engine V2 alinhados em cap/ds; o lab ainda não modela `immediateDisasterDump` de forma isolada.
2. **Fill maker:** `bid >= limit` não modela fila, print, latência ou cancelamento. Rodar cenários sem fill, atraso e fill parcial.
3. **Fees:** separar fee de entrada taker, saída maker comprovada e residual taker; não usar fee zero por presunção.
4. **Reconciliação:** testar fill parcial, FAK miss, ACK-only, cancelamento falho, saldo atrasado e shutdown.
5. **Hyperion Gold:** manter fora do executor até implementar de verdade a fração de saída, `dangerExit`, atualização por execution event e uma validação econômica separada.
6. **OOS agosto:** validar V2 em dados novos (pós-31/07) antes do dry longo.

## 7. Protocolo de teste sem autoengano

### Fase 0 — reparo de paridade

- adicionar o pre-dump ao simulador ou removê-lo do claim até o simulador reproduzi-lo;
- criar fixtures para `OPEN → rescue`, `OPEN → disaster`, gap direto e fill parcial;
- conferir ids, timestamps, fee, side, quantidade e resultado final;
- rejeitar qualquer relatório que assuma fill no ask sem marcar o fill model.

### Fase 1 — replay e OOS congelado

- smoke curto para verificar dados e schema;
- congelar o OOS antes de escolher `ds15`/`ds25`, ladder ou sizing;
- rodar `e-golden ds15` como primário e `ds25` como challenger, ambos com o mesmo dataset;
- testar latência 0/80/150/350 ms, slippage, no-fill, fill parcial, book fino e taxa adversa;
- reportar PnL pré-fee e líquido, fees, EV/share, WR, PF, média/mediana de win/loss, cauda, sequência de perdas, pior dia, DD cronológico e capital finito.

### Fase 2 — dry/shadow read-only

Executar somente observação, sem ordem CLOB, por pelo menos 24–48 eventos para validar encanamento e por uma amostra de promoção de pelo menos 100 eventos/7 dias. Registrar:

- sinal no instante da decisão e preço/size observado;
- decisão rejeitada e motivo;
- sinal → envio → ACK → fill e latência;
- fill parcial e slippage realista;
- fill maker real, `trader_side`, taxa e tempo na fila;
- toda transição da máquina de estados;
- orphan, ordem presa, reconciliação e divergência de saldo.

### Fase 3 — micro, somente com autorização explícita

O micro só começa depois de Fase 0–2 passarem. Usar o envelope de $5/$40/$8/8 eventos, sem alterar `.env`, sem `test:order` e sem habilitar live nesta consolidação. Cada sessão termina com reconciliação auditável.

### Fase 4 — promoção ou morte

Promover apenas se todos os itens forem verdadeiros:

- paridade exata e cobertura temporal comprovada;
- OOS congelado com pelo menos 1.000 eventos e período contínuo recente;
- resultado líquido de fees com EV positivo e intervalo de confiança inferior acima de zero, sem depender de uma semana curta;
- PF mínimo de referência 1,20 **junto** com DD, cauda, pior dia e bankroll finito aceitáveis;
- zero orphan/unresolved fill em shadow e micro;
- latência, fill rate, maker share e slippage medidos, não estimados;
- nenhuma violação de limite ou circuito aberto não tratado.

Falhou uma proteção ou a economia líquida: matar a variante, preservar o relatório e voltar à pesquisa. Não otimizar depois de olhar o OOS.

## 8. Operação e observabilidade

Cada sessão precisa emitir um journal append-only com:

- versão do código, preset e parâmetros;
- data coverage e fonte de cada tick;
- decisão, motivo de bloqueio, ordem, id, quantidade solicitada/matched e preço real;
- fee e `trader_side`;
- estado anterior/novo, motivo de saída e residual;
- PnL bruto, fee, PnL líquido, exposure, DD e limites restantes;
- reconciliação final e status `CLEAN`/`ORPHAN`.

O dashboard é visualização; a fonte de verdade é o journal reconciliado. PF, WR ou `dailyMetrics` isolados nunca autorizam promoção.

## 9. Artefatos que formam esta decisão

### Executor principal

- `scripts/binance-lead-scalp/scalp-engine.js`
- `scripts/binance-lead-scalp/scalp-dry.js`
- `scripts/binance-lead-scalp/scalp-live.js` — apenas após autorização explícita
- `scripts/binance-lead-scalp/GOLDEN-GOOSE.md`
- `scripts/binance-lead-scalp/HANDOFF-LIVE-ANALYSIS.md`
- `scripts/binance-lead-scalp/HANDOFF-OPTIMIZATION-SOLUTIONS.md`

### Evidência de replay

- `D:\Projetos\projeto-goldenlens\data-backtest\labs\sandbox\binance-lead-scalp\run-scalp-lab.mjs`
- `D:\Projetos\projeto-goldenlens\data-backtest\labs\sandbox\binance-lead-scalp\reports\`
- `D:\Projetos\projeto-goldenlens\data-backtest\scripts\lab-polymarket-5m-hft.js` — exploratório; não é evidência de promoção

### Estado dos artefatos não commitados

Os arquivos novos `src/strategy/hyperionGoldV1.js`, `src/tfc/hyperionGoldEvaluate.js` e `src/tfc/preset-hyperion-gold.js` foram auditados, mas não entram no caminho canônico desta estratégia. O registro do Hyperion no composition registry não deve ser interpretado como validação econômica.

## Veredito

**Testar:** `e-golden V2 / budget $5 / sharesCap@0.50 / impulseCap 20 / rescueStop 0.25 / immediate disaster dump / ladder +$0.08,+$0.14`.  
**Testar separado:** Midas `btc-gold-v1` em shadow independente (não misturar com o scalp).  
**Não testar como rota de ganho:** pair/complete-set, SHOTANDGO/Phil, TSC atual, Hyperion antigo, Apex curto ou o novo Hyperion Gold sem fechar as lacunas.  
**Não operar ao vivo nesta etapa:** primeiro paridade (feita no engine 05/08), OOS agosto, shadow Giovanna e gates de defesa.
