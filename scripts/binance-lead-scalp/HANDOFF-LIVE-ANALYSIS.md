# Handoff: Binance-lead scalp LIVE — forense + lab + estado atual

Documento **autossuficiente** para outra IA analisar o que aconteceu no live micro, o que o lab valida, e o que está rodando agora. Não depende do histórico de chat.

**Data do relatório:** 2026-08-03 (~00:50 BRT)  
**Repos:** `data-robot` (live) + `data-backtest` (lab)  
**Ops:** Coolify Giovanna · sidecar Docker `pair-path-micro`  
**Mercado:** Polymarket BTC Up/Down 5m · lead Binance spot  

---

## 0. Como usar este pacote (checklist para a IA receptora)

1. Ler este MD por completo.
2. Abrir os JSON em [`handoff-artifacts/`](./handoff-artifacts/) (cópia local dos artefatos críticos).
3. Cruzar com código em `scripts/binance-lead-scalp/` e lab em `data-backtest/labs/sandbox/binance-lead-scalp/`.
4. **Não** alterar `minTau` default sem novo lab — já foi testado e **prejudica** PnL.
5. Live gasta dinheiro real: qualquer mudança de harness exige `--live` explícito + caps de sessão.

### Paths absolutos (Windows)

| Artefato | Path |
|---|---|
| Este doc | `d:\Projetos\projeto-goldenlens\data-robot\scripts\binance-lead-scalp\HANDOFF-LIVE-ANALYSIS.md` |
| Artefatos JSON (cópia) | `d:\Projetos\projeto-goldenlens\data-robot\scripts\binance-lead-scalp\handoff-artifacts\` |
| Lab baseline ds15 | `d:\Projetos\projeto-goldenlens\data-backtest\labs\sandbox\binance-lead-scalp\reports\scalp-2026-05-01_2026-07-31_maker-ladder-0p08-0p14_full-adapt-rescue-ds15.json` |
| Lab mintau compare | `d:\Projetos\projeto-goldenlens\data-backtest\labs\sandbox\binance-lead-scalp\reports\mintau-compare-full-2026-05-01_2026-07-31.json` |
| Dry handoff (plumbing) | `d:\Projetos\projeto-goldenlens\data-robot\scripts\binance-lead-scalp\HANDOFF-DRY-SIMULATION.md` |

### No container Giovanna (`pair-path-micro`)

| Artefato | Path |
|---|---|
| Log live atual | `/tmp/scalp-e-adapt-live.log` |
| Reports live | `/usr/src/app/runs/binance-lead-scalp-live/` |
| Summary sessão −$1.20 | `/usr/src/app/runs/binance-lead-scalp-live/summary_1785726299140.json` |
| Boot micro | `/usr/src/app/scratch/boot-scalp-micro.sh` |

---

## 1. O que é a estratégia

**Nome:** `binance-lead-scalp` · variante **`e-adapt`**  
**Espelho lab (GO):** tag `full-adapt-rescue-ds15`

### Regras de decisão (engine puro)

Arquivo: [`scalp-engine.js`](./scalp-engine.js)

| Parâmetro | Valor ds15 / e-adapt live |
|---|---|
| Impulso | `clamp(2.5 × σ(Δspot 2s, janela 300s), $5, $12)`; fallback $8 |
| Lead | 2s Binance vs book |
| Ask range | 0.15–0.70 |
| Spread máx | 0.04 |
| Stale mid | ≤ 0.03 |
| Entrada | taker no ask |
| Saída | maker ladder **+8¢ / +14¢** (50/50 shares no lab; live micro costuma caber em 1 nível por min 5 sh) |
| Stop soft | −5¢ → entra **rescue** (ask maker entry+1¢) |
| Disaster | `rescueStop=0.15` → dump taker se bid ≤ entry−15¢ |
| Timeout | 20s hold → rescue (se rescue on) |
| τ entrada | **20–280** s restantes |
| Budget lab | $10 |
| Fee model | taker rate 0.07 × p(1−p) × shares |

### Onde roda o quê

| Camada | Path | Papel |
|---|---|---|
| Engine puro | `scalp-engine.js` | tryEntry / managePosition / fees — **sem I/O** |
| Live I/O | `scalp-live.js` | CLOB real, CTF lag, cancel/flatten, caps sessão |
| Dry I/O | `scalp-dry.js` | fills simulados; **recusa** `--live` |
| Lab | `data-backtest/.../run-scalp-lab.mjs` | lake Parquet + Binance 1s |
| Dashboard | `scalp-dashboard.js` | `http://127.0.0.1:3211` SSH read-only Giovanna |

---

## 2. Expectativa de edge (importante — não confundir)

O usuário espera “**quando ganha, ganha mais do que quando perde**” por causa das proteções.

### O que o lab realmente mostra (budget $10, mai–jul 2026)

Fonte: [`handoff-artifacts/lab/baseline-ds15-summary-only.json`](./handoff-artifacts/lab/baseline-ds15-summary-only.json)  
(ou report completo no data-backtest — ver §7)

| Métrica | Valor |
|---|---:|
| Trades | 52 030 |
| Win rate | **74.55%** |
| PnL | **+$50 687** |
| Profit factor | **3.062** |
| avgWin | +$1.94 |
| avgLoss | −$1.86 |
| maxDD | $126.85 |

**PnL por motivo de saída:**

| reason | n | sum PnL | avg |
|---|---:|---:|---:|
| `ladder_full` | 26 412 | +$66 204 | **+$2.51** |
| `rescue_full` | 19 352 | +$8 147 | +$0.42 |
| `rescue_stop` | 6 069 | **−$23 495** | **−$3.87** |
| `rescue_eod` | 197 | −$168 | −$0.85 |

**Conclusão analítica:**

- O edge **não** é “cada win > cada loss em magnitude”.
- O edge é **WR alta** + muitos `ladder_full` / `rescue_full`.
- Quando o disaster stop dispara (`rescue_stop`), a perda média (**−$3.87**) **é maior** que um ladder win típico (**+$2.51**).
- Proteção correta = cortar em −15¢ (não hold até settlement = −100% do notional). Isso já salvou sessões anteriores que iam a zero.

---

## 3. Sessão forense −$1.20 (micro budget $3)

### Summary

Arquivo local: [`handoff-artifacts/live-session-minus120/summary_1785726299140.json`](./handoff-artifacts/live-session-minus120/summary_1785726299140.json)

| Campo | Valor |
|---|---|
| generatedAt | 2026-08-03T03:04:59.139Z |
| variant | e-adapt |
| budget | **$3** |
| events | 4 |
| trades | 2 |
| WR | 50% |
| liquido | **−$1.20** |
| notionalUsed | $5.83 |
| exitReasons | `ladder_full:1`, `rescue_stop:1` |

### Cruzamento data-api (atividade on-chain/API)

Janela aproximada `ts ≥ 1785725000` (Unix s):

| ts | side | outcome | px | size | usdc | slug |
|---|---|---|---:|---:|---:|---|
| 1785725622 | BUY | Down | 0.58 | 5.17 | 3.09 | …5400 |
| 1785725627–28 | SELL | Down | 0.66 | 5+0.17 | 3.41 | …5400 |
| 1785725979 | BUY | Up | 0.34 | 8.33 | 2.96 | …5700 |
| 1785725984 | SELL | Up | 0.18 | 8.33 | 1.41 | …5700 |

**Net activity ≈ −$1.22** (bate com bot −$1.20). Sem órfão / inventário preso.

### Trade a trade

#### Evento `…5100` — 0 trades

Arquivo: [`scE_live_btc-updown-5m-1785725100_1785725399015.json`](./handoff-artifacts/live-session-minus120/scE_live_btc-updown-5m-1785725100_1785725399015.json)  
Blocks dominantes: `NO_IMPULSE`.

#### Evento `…5400` — WIN +$0.35

Arquivo: [`scE_live_btc-updown-5m-1785725400_1785725699038.json`](./handoff-artifacts/live-session-minus120/scE_live_btc-updown-5m-1785725400_1785725699038.json)

| Campo | Valor |
|---|---|
| side | DOWN |
| entryAsk | 0.58 |
| exitPx | 0.6655 |
| shares | 5.17 |
| reason | `ladder_full` |
| tauAtEntry | **79** |
| holdSec | 3.919 |
| pnl | **+$0.3536** |
| makerExit | 100% |

Antes: 3× `ENTER aborted below_min_shares` (ask 0.64 → `$3/0.64 < 5` shares mínimas).

#### Evento `…5700` — LOSS −$1.55 (origem do prejuízo)

Arquivo: [`scE_live_btc-updown-5m-1785725700_1785725999055.json`](./handoff-artifacts/live-session-minus120/scE_live_btc-updown-5m-1785725700_1785725999055.json)

| Campo | Valor |
|---|---|
| side | UP |
| entryAsk | 0.34 |
| exitPx | **0.18** |
| shares | **8.33** |
| reason | `rescue_stop` |
| tauAtEntry | **22** |
| holdSec | 2.408 |
| pnl | **−$1.5497** |
| makerExit | 0% (dump taker) |

Sequência no log:

1. Underfills abortados (DOWN@0.53, UP@0.45) — filled=0, sem inventário.
2. ENTER UP intent ask≈0.36 → fill **@0.34** sh=8.33 (budget $3 / ask baixo → muitas shares).
3. Ladder rest @0.42.
4. Stop (−5¢) → rescue (ask ~entry+1¢).
5. Bid fura disaster (entry−0.15 ≈ 0.19) → **dump @0.18**.

#### Evento `…6000` — 0 trades

Arquivo: [`scE_live_btc-updown-5m-1785726000_1785726299019.json`](./handoff-artifacts/live-session-minus120/scE_live_btc-updown-5m-1785726000_1785726299019.json)  
ENTER UP underfill filled=0.

### Assimetria observada nesta sessão (inversa do desejado)

| | ¢/share | shares | $ |
|---|---:|---:|---:|
| Win ladder | +~8.5¢ | 5.17 | +$0.35 |
| Loss rescue_stop | −16¢ | 8.33 | −$1.55 |

Fatores: ask barato → mais shares no mesmo budget; disaster −15¢ > ladder +8¢; entrada τ=22s.

---

## 4. Hipótese “subir minTau” — **rejeitada pelo lab**

Script: `data-backtest/labs/sandbox/binance-lead-scalp/run-mintau-compare.mjs`  
Resultado: [`handoff-artifacts/lab/mintau-compare-full-2026-05-01_2026-07-31.json`](./handoff-artifacts/lab/mintau-compare-full-2026-05-01_2026-07-31.json)

Janela idêntica ao GO: **2026-05-01 → 2026-07-31**, mesmo setup ds15, só muda `minTau`.

| minTau | PnL | ΔPnL% | PF | Δ rescue_stop n |
|---:|---:|---:|---:|---:|
| **20** (baseline) | 50 687 | — | 3.062 | — |
| 25 | 50 395 | −0.58% | 3.055 | −11 |
| 30 | 50 003 | −1.35% | 3.041 | −17 |
| 45 | 48 603 | −4.11% | 3.003 | −71 |
| 60 | 46 210 | −8.83% | 2.937 | −151 |

**Veredito:** manter `minTau=20`. Subir τ corta pouco `rescue_stop` e **reduz lucro**. Flags `--min-tau` / `--max-tau` existem no live/dry para experimentos, mas **não** mudam o default da strategy.

Reports lab individuais (data-backtest):

- `..._full-adapt-rescue-ds15.json` (baseline)
- `..._full-adapt-rescue-ds15-tau25.json`
- `..._full-adapt-rescue-ds15-tau30.json`
- `..._full-adapt-rescue-ds15-tau45.json`
- `..._full-adapt-rescue-ds15-tau60.json`

---

## 5. Incidents anteriores (contexto de hardening do live)

Antes do micro −$1.20 houve perdas maiores e near-misses. Hardening já no código de `scalp-live.js`:

| Problema | Mitigação implementada |
|---|---|
| Rescue hold até zero (`rescueStop=0`) → perda 100% notional | Default live **`rescueStop=0.15`** |
| Fill + reject pós-slip → órfão; dump falhou (CTF lag) | `acceptSlippedAsk`, ladder retries, `forceDump` com retries, orphan check no SIGTERM |
| SIGTERM no meio do ENTER só cancelava | Flatten + orphan balance check no signal handler |
| `getTrades` às vezes não vê fill | Cruzar **data-api activity** + CTF balance |

Scripts utilitários: `flatten-active.js`, `flatten-token.js`, `cancel-open.js`, `list-open.js`, `pnl-now.js`, `audit-*.js`, `probe-micro-live.js`.

---

## 6. Sessão live em andamento (após forense)

**Status no momento da escrita deste doc:** processo ativo no `pair-path-micro`.

```
node scripts/binance-lead-scalp/scalp-live.js --live --variant=e-adapt \
  --budget=5 --min-tau=20 --max-events=4 \
  --max-session-notional=20 --max-session-loss=5 \
  --rescue-stop=0.15 --max-book-age-ms=1200
```

Boot: [`scratch/boot-scalp-micro.sh`](../../scratch/boot-scalp-micro.sh) (no repo local; espelhado no container).

| Flag | Valor | Motivo |
|---|---|---|
| budget | **$5** (antes $3) | Menos distorção vs lab $10; menos oversize em ask barato |
| minTau | **20** | Lab GO; não subir |
| rescueStop | **0.15** | Disaster cut (ds15) |
| max-events | 4 | Micro |
| max-session-notional | 20 | Cap risco |
| max-session-loss | 5 | Stop de sessão |

Evento 1 da sessão nova (`…8700`): book extremo, 0 trades (`ASK_RANGE`/`NO_IMPULSE`) — report já escrito no container. Evento 2 (`…9000`) em andamento na época do snapshot.

Dashboard local: `http://127.0.0.1:3211` (se porta em uso, o painel antigo já serve).

---

## 7. Índice completo de artefatos

### 7.1 Copiados neste handoff (`handoff-artifacts/`)

```
handoff-artifacts/
  live-session-minus120/
    summary_1785726299140.json
    scE_live_btc-updown-5m-1785725100_1785725399015.json
    scE_live_btc-updown-5m-1785725400_1785725699038.json
    scE_live_btc-updown-5m-1785725700_1785725999055.json
    scE_live_btc-updown-5m-1785726000_1785726299019.json
  lab/
    mintau-compare-full-2026-05-01_2026-07-31.json
    baseline-ds15-summary-only.json   # só .summary do baseline (leve)
```

### 7.2 Lab no data-backtest (canônicos)

Diretório: `d:\Projetos\projeto-goldenlens\data-backtest\labs\sandbox\binance-lead-scalp\`

| Arquivo | Uso |
|---|---|
| `run-scalp-lab.mjs` | Simulador |
| `run-mintau-compare.mjs` | Sweep minTau vs baseline |
| `run-month-full.mjs` | Suite de variantes full |
| `reports/scalp-2026-05-01_2026-07-31_*_full-adapt-rescue-ds15.json` | Baseline GO |
| `reports/scalp-2026-05-01_2026-07-31_*_full-adapt-rescue-ds15-tau{25,30,45,60}.json` | Ablation τ |
| `reports/mintau-compare-full-2026-05-01_2026-07-31.json` | Tabela Δ |
| `reports/scalp-2026-05-01_2026-07-31_*_full-adapt-rescue-ds15.md` | Resumo humano baseline |

### 7.3 Código live crítico

| Arquivo | O que olhar |
|---|---|
| `scalp-engine.js` | `VARIANT_E_ADAPT`, `managePosition`, `enterRescue`, `tryEntry` |
| `scalp-live.js` | parseArgs (`--min-tau`, `--rescue-stop`), forceDump, pre-rescue/pre-dump cancel, SIGTERM flatten |
| `scalp-dry.js` | mesma flags de τ; sem CLOB |
| `README.md` | flags ops |
| `HANDOFF-DRY-SIMULATION.md` | arquitetura feeds/dry |

### 7.4 Como puxar artefatos frescos da Giovanna

```powershell
# status
cmd /c "ssh Giovanna docker exec pair-path-micro sh -c \"tail -n 40 /tmp/scalp-e-adapt-live.log\""

# listar reports
cmd /c "ssh Giovanna docker exec pair-path-micro ls -1t /usr/src/app/runs/binance-lead-scalp-live"

# copiar summary mais recente
cmd /c "ssh Giovanna docker cp pair-path-micro:/usr/src/app/runs/binance-lead-scalp-live/summary_<TS>.json /tmp/"
scp Giovanna:/tmp/summary_<TS>.json .
```

Evitar pipes complexos com `grep` dentro de `ssh` via PowerShell (quebra quoting). Preferir script `.sh` no container.

### 7.5 Data-api (ground truth de fills)

```
GET https://data-api.polymarket.com/activity?user=<POLYMARKET_FUNDER_ADDRESS>&limit=80
```

`POLYMARKET_FUNDER_ADDRESS` vem do `.env` do container (Coolify engine BTC). **Não** logar secrets.

Script de forense usado: `scratch/q-session-forensic.mjs` (rodar **dentro** de `/usr/src/app` para resolver `dotenv`).

---

## 8. Perguntas abertas / próximos eixos de análise (para a IA receptora)

1. **Assimetria micro vs lab:** com budget baixo e ask barato, `shares = budget/ask` infla loss de `rescue_stop`. Vale **cap de shares** ou **minAsk dinâmico** sem mudar `minTau`? Precisa lab A/B.
2. **Skip rescue se bid já ≤ entry−rescueStop no tick do stop** — dump imediato vs postar rescue e gappar pior. Medir no lab/live.
3. **Underfills** frequentes no live (liquidez) vs lab fill-on-ask — bias de seleção; paper cruel já existe no dry.
4. **Ladder live com min 5 shares:** muitas vezes 1 nível (+8¢) só — lab assume 50/50 +8/+14. Impacto de EV?
5. **Sessão atual (budget $5):** ao terminar, anexar `summary_*.json` novo e comparar distribuição de `exitReasons` com a sessão −$1.20.

---

## 9. Restrições operacionais (obrigatório)

- `data-robot` é o **único** app que opera dinheiro real neste monorepo.
- **Não** rodar `npm run test:order` sem pedido explícito.
- **Não** commitar `.env` / expor API secret / passphrase.
- Credenciais L2 devem alinhar a `POLYMARKET_FUNDER_ADDRESS` / `SIGNATURE_TYPE` (`docs/polymarket-*.md`, `npm run check:api-key`).
- Estratégia/backtest estatístico mora no **`data-backtest`**, não forkar lógica no robot além do harness.

---

## 10. Transcript / chat (opcional)

Conversa Cursor que gerou este ciclo (forense −$1.20, mintau lab, restart live):  
`C:\Users\lamar\.cursor\projects\d-Projetos-projeto-goldenlens-data-robot\agent-transcripts\9e6f9eb9-3cb0-4aac-b443-40613dbe187c\9e6f9eb9-3cb0-4aac-b443-40613dbe187c.jsonl`

Preferir **este MD + JSONs** como fonte de verdade; o transcript é ruído longo.

---

## 11. One-liner para a próxima IA

> Analise `HANDOFF-LIVE-ANALYSIS.md` + `handoff-artifacts/`. Sessão live micro budget$3 fechou −$1.20 (win ladder +$0.35 @τ79; loss rescue_stop −$1.55 @τ22 dump 0.18). Lab ds15 mai–jul GO (+$50.7k, PF 3.06); subir minTau **corta** PnL — manter 20. Edge = WR~75% + ladder/rescue_full, **não** win$ > loss$ em todo trade. Live atual: budget$5, rescueStop0.15, minTau20, caps sessão. Próximo foco útil: assimetria de size em ask barato / cap shares — com lab A/B — sem mexer em minTau.
