# Binance-lead scalp — dry + LIVE (Giovanna)

- **Dry**: zero ordens CLOB (`scalp-dry.js`, recusa `--live`)
- **Live**: ordens reais (`scalp-live.js`, exige `--live`)

## Variante default: `e-adapt`

- Impulso **adaptativo**: `clamp(2.5 × σ(Δ2s, 5min), $5, $12)` (fallback fixo `$8` até haver σ)
- Stale mid ≤ **0.03**
- Entrada taker no ask · saída maker **50% +8¢ / 50% +14¢**
- **Modo resgate**: stop −5¢ / timeout 20s **não dumpa** — reposiciona ask maker em
  `entry+1¢` e segura até o fim do evento (dump no bid só no EOD)
- τ **20–280** · máx **5**/evento · budget **$10**

Outras: `--variant=e` ($12/0.02 fixo) · `--variant=e-freq` ($8/0.03 fixo).

Spot: **Binance WS** · Book: **CLOB WS**.

| Script | Uso |
|---|---|
| `scalp-dry.js` | Dry multi-evento |
| `scalp-live.js` | Live (CLOB real) |
| `scalp-engine.js` | Lógica pura (espelha lab) |
| `scalp-dashboard.js` | Painel local SSH |
| `HANDOFF-DRY-SIMULATION.md` | Doc técnica dry |
| `HANDOFF-LIVE-ANALYSIS.md` | Forense live −$1.20 + lab mintau + artefatos JSON |

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
| `--variant` | `e-adapt` | `e` \| `e-freq` \| `e-adapt` |
| `--impulse-vol-mult` | 2.5 (adapt) | `0` = limiar fixo |
| `--impulse-floor` / `--impulse-cap` | 5 / 12 | |
| `--vol-window` | 300 | segundos para σ |
| `--impulse-usd` | 8 | fallback / modo fixo |
| `--stale-mid` | 0.03 | |
| `--rescue` / `--no-rescue` | on (adapt) | modo resgate |
| `--rescue-offset` | 0.01 | ask breakeven+offset |
| `--rescue-stop` | 0 dry / **0.15 live** | stop-desastre $; 0 = segura até EOD |
| `--min-tau` / `--max-tau` | 20 / 280 | janela de entrada (s restantes) |
| `--fill` | `honest` (dry) | `cruel` = latency + slip |
| `--max-events` | 24 dry / 6 live | |
| `--max-session-notional` | budget×8 (live) | teto notional sessão |
| `--max-session-loss` | 25 (live) | para se PnL ≤ −cap |
| `--live` | — | dry: **recusado** · live: **obrigatório** |

## Lab reference (adaptativo + resgate)

Mai–jun: PnL ~+$32.5k · maxDD ~$78 · GO  
Julho: PnL ~+$8.4k · maxDD ~$10 · GO  

Sem resgate (só adaptativo): mai–jun +$27.1k · julho +$7.4k.  
Caveat: `rescue_eod` dumpa no bid do último tick (~EV do settlement); ao vivo o
resultado individual é binário — média converge com amostra.

Lab: `run-scalp-lab.mjs --impulse-vol-mult 2.5 --rescue --rescue-offset 0.01 --rescue-stop 0 ...`
