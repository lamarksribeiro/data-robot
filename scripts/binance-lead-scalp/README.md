# Binance-lead scalp — dry + LIVE (Giovanna)

- **Dry**: zero ordens CLOB (`scalp-dry.js`, recusa `--live`)
- **Live**: ordens reais (`scalp-live.js`, exige `--live`)

## Variante default: `e-golden` 🥇

**Candidato principal de pesquisa/shadow** — alpha de replay com cauda reduzida para o teste. Ainda não é promoção para conta real; veja [`docs/ESTRATEGIA-MESTRA-BTC5M-2026-08-04.md`](../../docs/ESTRATEGIA-MESTRA-BTC5M-2026-08-04.md) para o veredito e os gates.

| Peça | Valor |
|---|---|
| Impulso | `clamp(2.5 × σ(Δ2s, 5min), $5, $20)` (fallback $8) — **V2** |
| Stale mid | ≤ 0.03 |
| Entrada | taker no ask · **sizing `sharesCap@0.50`** |
| Saída | maker **50% +8¢ / 50% +14¢** |
| Rescue | stop −5¢ / timeout 20s → ask maker `entry+1¢` |
| Disaster | **`rescueStop=0.25`** + **pre-dump** se bid já ≤ entry−25¢ — **V2** |
| τ | 20–280 · máx 5/evento · budget $5 (micro) / $10 (lab) |

### Por que `e-golden` V2 e não V1 / `e-adapt`?

Lab V2 sharesCap (mai–jul, tag `aud-golden-v2-c20-b5-ds25`):

| Setup | PnL | PF | maxDD | WR |
|---|---:|---:|---:|---:|
| golden V1 b5 (cap12/ds25) | +$20.077 | 3,66 | $32,22 | 76,8% |
| **golden V2 b5 (cap20/ds25)** | **+$20.095** | **4,71** | **$14,26** | **80,4%** |
| golden V2 b10 | +$38.631 | 4,63 | $28,51 | 80,2% |

Mesmo PnL, **−56% DD**, menos disasters. Doc: `data-backtest/docs/estrategias/estrategia-definitiva-btc-5m-golden-v2-2026-08-05.md`.

Sessão forense micro (−$1.20): win +$0.35 (5.17 sh @0.58) vs loss −$1.55 (8.33 sh @0.34).  
Com cap: max shares = `floor(budget/0.50)` → no budget $3, teto **6 sh** (não 8.8).

**Pre-dump:** se o bid gappa direto para zona de desastre, o live **não** posta rescue maker inútil — dump taker imediato.

Outras variantes:

| Flag | Uso |
|---|---|
| `--variant=e-golden` | **default** shadow/dry (V2: cap20/ds25) |
| `--variant=e-adapt` | lab-mirror (sizing none, rescueStop 0 no engine; live ainda força ds) |
| `--variant=e-freq` | limiar fixo $8 |
| `--variant=e` | limiar fixo $12 / stale 0.02 |

Spot: **Binance WS** · Book: **CLOB WS**.

| Script | Uso |
|---|---|
| `scalp-dry.js` | Dry multi-evento |
| `scalp-live.js` | Live (CLOB real) |
| `scalp-engine.js` | Lógica pura (espelha lab) |
| `scalp-dashboard.js` | Painel local SSH |
| `HANDOFF-DRY-SIMULATION.md` | Doc técnica dry |
| `HANDOFF-LIVE-ANALYSIS.md` | Forense live −$1.20 + lab mintau |
| `HANDOFF-OPTIMIZATION-SOLUTIONS.md` | Cap + pre-dump (agora no código) |

## Local

```powershell
npm run scalp-e:dry
npm run scalp-e:live -- --live --max-events=6 --budget=10
npm run scalp-e:dashboard
```

Painel: [http://127.0.0.1:3211](http://127.0.0.1:3211) (SSH read-only Giovanna; prefere log LIVE).

## Flags

| Flag | Default | Nota |
|---|---|---|
| `--variant` | `e-golden` | `e` \| `e-freq` \| `e-adapt` \| `e-golden` |
| `--sizing` | golden: `sharesCap` | `none` \| `sharesCap` \| `dynamicBudget` \| `liqCap` |
| `--shares-cap-ask` | `0.50` | ref do cap (`maxSh = floor(budget/askRef)`) |
| `--impulse-vol-mult` | 2.5 (adapt) | `0` = limiar fixo |
| `--impulse-floor` / `--impulse-cap` | 5 / 12 | |
| `--vol-window` | 300 | segundos para σ |
| `--impulse-usd` | 8 | fallback / modo fixo |
| `--stale-mid` | 0.03 | |
| `--rescue` / `--no-rescue` | on (golden/adapt) | modo resgate |
| `--rescue-offset` | 0.01 | ask breakeven+offset |
| `--rescue-stop` | **0.15** golden / live | stop-desastre $; 0 = segura até EOD |
| `--immediate-disaster-dump` / `--no-…` | on | gap → dump sem rescue maker |
| `--min-tau` / `--max-tau` | 20 / 280 | **não subir minTau** (lab −8.8% em 60) |
| `--fill` | `honest` (dry) | `cruel` = latency + slip |
| `--max-events` | 24 dry / 6 live | |
| `--max-session-notional` | budget×8 (live) | teto notional sessão |
| `--max-session-loss` | 25 (live) | para se PnL ≤ −cap |
| `--live` | — | dry: **recusado** · live: **obrigatório** |

## Lab reference

| Tag | PnL | PF | maxDD | Nota |
|---|---:|---:|---:|---|
| full-adapt-rescue-ds15 | +$50.7k | 3.06 | $127 | sem cap |
| full-adapt-rescue-ds15-**cap50** | +$37.0k | 3.12 | $89 | **e-golden sizing** |
| full-adapt-rescue (hold, rs=0) | +$67.7k | 19.7 | $78 | paper-only; live pode ir a −100% notional |

Caveat: maker fill no lab é proxy `bid≥limit`; ao vivo o resultado individual é binário — média converge com amostra.

## Micro live recomendado (Giovanna)

```bash
node scripts/binance-lead-scalp/scalp-live.js --live --variant=e-golden \
  --budget=5 --min-tau=20 --max-events=8 \
  --max-session-notional=40 --max-session-loss=8 \
  --rescue-stop=0.15 --max-book-age-ms=1200
```

Checklist: copiar `scripts/binance-lead-scalp/` para o container → dry 4–8 eventos → micro live com caps.
