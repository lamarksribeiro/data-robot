# Falhas de envio de ordens — achados e mitigações

**Data:** 27/07/2026  
**Escopo:** data-robot live (Coolify Giovanna) × Polymarket CLOB × labs contrafactuais em `execution-audit`  
**Não é:** backtest no lakehouse (`data-backtest`). Validação PnL abaixo é contrafactual sobre audits live.

---

## Resumo executivo

As falhas de envio (ENTER, EXIT de proteção, REVERSE) concentram-se em poucos motivos CLOB e num efeito interno do robô: o **circuit breaker do risk** trata miss esperado (FAK sem liquidez, min size) como falha de sistema e **bloqueia proteção** (`CIRCUIT_OPEN`).

| Prioridade | Mudança proposta | O que melhora | Evidência |
|------------|------------------|---------------|-----------|
| P0 | FAK miss / min_size não abrem circuit; EXIT/REVERSE ignoram circuit | Proteção volta a funcionar após misses de entrada | BTC CF **+$3,78** / 7 markets; simulação mecânica |
| P0 | EXIT size ≤ saldo CONDITIONAL; sem loop no qty OMS | Para cascata balance → circuit | SOL: 5 rejects balance → **25** CIRCUIT |
| P1 | Não emitir `odds_shock_partial` se qty &lt; minSize | Menos reject inútil no canário ~$2,5 | 5 REJECT min5; posição full já 3–4 (&lt;5) |
| P2 | Slip escalonado no retry ENTER | Complementar | 65% dos FAK miss já viram fill depois (retry atual) |

**Nuance:** no SOL, o contrafactual “liberar todo REVERSE negado por CIRCUIT” deu **−$1,64** em 1 market. Bypass do circuit ≠ forçar reverse com mid/ask tóxico.

---

## Fontes

| Fonte | Detalhe |
|-------|---------|
| Audits BTC | `live-midas-carry-v1_btc5m_primary/execution-audit` · 25–28/07/2026 |
| Audits SOL | `live-midas-carry-v1_sol5m_primary/execution-audit` · 27/07/2026 |
| Docs Polymarket | [Error codes](https://docs.polymarket.com/resources/error-codes) |
| Issues CLOB | py-clob-client #265 (SELL CONDITIONAL), #287/#342 (cache `sum_of_matched_orders`) |
| Código | `liveTransport.js`, `runtime.js` (`recordFailure`), `reverseSaga.js`, `preset-midas.js`, `midasV1.js` |
| Labs | `scripts/labs/lab-order-failure-mitigations.mjs`, `scripts/labs/lab-circuit-expected-rejects.mjs` |
| Report gerado | `runs/labs-audit-falhas/_out/mitigations-report.json` (local; não versionar audits) |

### Como reproduzir

```powershell
# Simulação mecânica do circuit (sem audits)
node scripts/labs/lab-circuit-expected-rejects.mjs

# Contrafactual sobre audits baixados da Giovanna
node scripts/labs/lab-order-failure-mitigations.mjs runs/labs-audit-falhas
```

---

## Política atual de ordens (MIDAS portfolio)

| Tipo | Order type | Motivo |
|------|------------|--------|
| ENTER | **FAK** | Controla slippage; não forçar fill ruim |
| EXIT / proteção (danger, early-warn, odds-shock, late-flip exit) | **GTC** | Fill garantido perto do expiry; FAK na saída falhava sem retry |
| REVERSE | EXIT GTC + ENTER FAK (saga) | Até 1+2 retries na saída com reprice; ENTER só se flat |

Comentário canônico: `src/tfc/preset-midas.js` (`exitOrderType = 'GTC'`).

Submit CLOB **sem retry** de propósito (evita ordem duplicada). Reconcile/cancelAll já têm `withRetry`.

---

## Motivos de falha (produção)

### Buckets BTC (25–28/07)

| Bucket | Rejects | Kind típico |
|--------|---------|-------------|
| FAK miss (`no orders found…`) | **77** | ENTER |
| min_size (`Size … lower than the minimum: 5`) | **5** | EXIT partial |
| REVERSE_EXIT_INCOMPLETE | 4 | REVERSE |
| REVERSE_ENTER_FAILED | 2 | REVERSE |
| CANCEL_FAILED | 1 | ENTER |
| **Total rejects** | **~89** | — |
| Settlements | 137 | baseline PnL ≈ **+$23,30** |

### Buckets SOL (27/07)

| Bucket | Rejects | Kind |
|--------|---------|------|
| `not enough balance / allowance` | **5** | EXIT (danger) |
| CIRCUIT_OPEN | **5** | EXIT (cascata) |
| CANCEL_FAILED | 1 | — |

### Denies de risk (pré-envio) — BTC

| Reason | Count (ordem de grandeza) |
|--------|---------------------------|
| `denied:REVERSE` / `CIRCUIT_OPEN` | ~**1.657–1.687** |
| `denied:ENTER` / `ONE_INTENT_PER_EVENT` | ~321 |
| `MAX_NOTIONAL_EVENT` | ~30 |

O volume de `CIRCUIT_OPEN` em REVERSE é o principal bloqueio de **proteção**, não de entrada.

---

## Cruzamento com Polymarket (CLOB)

| Mensagem / código | Quando | Contorno |
|-------------------|--------|----------|
| `no orders found to match with FAK order…` | ENTER FAK sem liquidez no ask | Retry (já existe ≤5); depth check; **não** abrir circuit |
| `Size (N) lower than the minimum: {min}` | EXIT partial / dust | Skip se qty &lt; min; full só se full ≥ min |
| `not enough balance / allowance` | SELL: saldo **CONDITIONAL**; BUY: pUSD | Sync `AssetType.CONDITIONAL` + size real; aprovações CTF |
| `order timed out` | Burst concorrente | Resubmit seguro (doc oficial) |
| tick size / FOK miss / post-only / cancel-only / 425 / 401 / 429 | Vários | Ver error-codes; auth via `derive-key:write` |

**SELL vs BUY:** balance de venda é token condicional, não collateral. Issues conhecidas de cache `sum_of_matched_orders` podem gerar “phantom lock” mesmo com saldo on-chain ok — backoff, não martelar.

---

## Labs — o que foi medido (não é backtest)

### A) Bypass circuit em REVERSE (`CIRCUIT_OPEN` → permitir)

| Asset | Denies CIRCUIT | Markets com Δ PnL | Δ PnL contrafactual |
|-------|----------------|-------------------|---------------------|
| BTC | 1.657 usable lateFlip | **7** | **+$3,78** (23,30 → 27,08) |
| SOL | 95 | 1 | **−$1,64** |

Cascata FAK miss → deny CIRCUIT no mesmo market (BTC): **3** eventos.

### B/C) Partial exit &lt; minSize

- 9 submits `odds_shock_partial` (BTC), todos qty &lt; 5  
- 5 REJECT min5; **4 FILL** mesmo com qty &lt; 5 (min5 **não é absoluto**)  
- Nos 5 rejects, posição **full** também &lt; 5 (3–4 shares no canário ~$2,5)  
- Contrafactual “try full anyway” vs hold: **−$0,66**  

**Conclusão lab:** skip partial &lt; min ajuda operacionalmente; “full exit ≥ 5” quase não aplica no sizing atual.

### D) Cap CONDITIONAL (SOL)

- Erro típico: `balance: 2142856` (~2,14) vs `order amount: 4000000` (~4,0)  
- Resize ≥ 5: **0/5**; residual &lt; 5: **5**  
- Cascata CIRCUIT após balance rejects: **25**  

**Conclusão lab:** sync + 1 tentativa residual ou skip; **nunca** loop com qty OMS.

### E) Simulação in-process (`lab-circuit-expected-rejects.mjs`)

| Política | Após 5 FAK miss | REVERSE | EXIT |
|----------|-----------------|---------|------|
| Baseline (hoje) | circuit OPEN | bloqueado | bloqueado |
| Proposed | circuit CLOSED | permitido | permitido |

### F) Slip / retry ENTER

- 77 FAK miss → **50** fills posteriores no mesmo market (**65%**)  
- Destes, **42** com `maxPrice` maior que o miss  

**Conclusão lab:** retry até 5 já captura a maior parte; slip escalonado é P2.

---

## O que as mudanças ajudam (e o que não)

### Ajudam

1. **Menos posição presa sem proteção** quando a entrada falhou por FAK miss e o circuit abriu.  
2. **Danger/EXIT deixa de entrar em loop** de balance/CIRCUIT (caso SOL).  
3. **Menos spam de reject** de partial &lt; min no canário pequeno.  

### Não ajudam / não prometem

- Mais entradas ou edge melhor do sinal MIDAS.  
- PnL de backtest lakehouse (ainda **não** modelado).  
- Reverse “sempre bom” — liberar circuit pode reativar flips ruins (SOL −$1,64 no CF).

---

## Proposta de implementação (quando for para código)

1. **`runtime.js` / risk:** lista de rejects CLOB “esperados” que **não** chamam `recordFailure` (FAK miss, min size, post-only mode, FOK miss). EXIT/REVERSE: avaliar circuit com bypass ou circuit separado.  
2. **Pré-EXIT live:** `updateBalanceAllowance(CONDITIONAL, tokenId)` + `size = min(omsQty, bal)`; se bal &lt; min e política skip → não postar; se postar residual, **uma** tentativa.  
3. **`midasV1` odds_shock PARTIAL:** se `exitQty < marketMinSize` → skip (ou full só se full ≥ min); não emitir partial que só rejeita.  

Testes sugeridos: estender `risk-p4` / `midas-v1` com os cenários do lab E e partial &lt; min.

---

## Lacunas

| Lacuna | Nota |
|--------|------|
| Sem backtest lakehouse | Modelar FAK miss → circuit → deny reverse / partial / exit size no `data-backtest` se quiser promoção por PnL histórico |
| ETH / DOGE / XRP | Audits curtos no dia do redeploy; amostra fraca |
| Normalizador `errorMsg` → reason codes | Ainda pass-through em `liveTransport`; labs usam regex |
| Phantom lock CLOB (#287/#342) | Mitigação client-side limitada (backoff) |

---

## Referências internas

- `docs/polymarket-configuracao-env.md` — balance, 401, derive-key  
- `docs/arquitetura/risk-p4.md` — circuit, fail-closed  
- `docs/operacao/evidencia-midas-exit-live-2026-07-22.md` — EXIT live (FAK na época)  
- Canvas (IDE): `falhas-envio-ordens.canvas.tsx`, `lab-falhas-envio-mitigacoes.canvas.tsx`
