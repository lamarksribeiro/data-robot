# Hyperion V4 Terminal — dry WS (Giovanna)

Harness **dry/shadow** do preset `btc-hyperion-terminal-v4`.
Spot **entrada: Binance** · **settle: Chainlink RTDS** · book CLOB · fill simulado · **zero ordens**.

| Script | Uso |
|---|---|
| `hyperion-dry.js` | Dry BTC com poll 50ms |
| `hyperion-engine.js` | Sinal Merton + settle (GLS + V4 params) |
| `hyperion-dashboard.js` | Painel local read-only |

## Params V4 (terminal)

- τ **5–60s** · ask 0,50–0,82 · netEdge ≥ 0,10 · spread ≤ 0,05 · jumpIntensity 0,50
- Budget default $15 · hold to settlement
- Entrada: Binance · Settle: Chainlink (oficial Poly)
- OBI / cross-event: fora (mortos no GLS)

## Giovanna (`pair-path-micro`)

```powershell
scp -P 2222 -r d:\Projetos\projeto-goldenlens\data-robot\scripts\hyperion root@65.21.146.77:/tmp/hyperion
scp -P 2222 d:\Projetos\projeto-goldenlens\data-robot\src\feeds\binanceSpotFeed.js root@65.21.146.77:/tmp/binanceSpotFeed.js
scp -P 2222 d:\Projetos\projeto-goldenlens\data-robot\src\feeds\marketState.js root@65.21.146.77:/tmp/marketState.js
scp -P 2222 d:\Projetos\projeto-goldenlens\data-backtest\labs\sandbox\hyperion\boot-dry.sh root@65.21.146.77:/tmp/boot-hyperion-dry.sh

cmd /c ssh Giovanna "bash /tmp/boot-hyperion-dry.sh 10 cruel"
```

Reports: `runs/hyperion-dry/` · log `/tmp/hyperion-dry-10.log`

## Painel

```powershell
npm run hyperion:dashboard
```

Abre [http://127.0.0.1:3210](http://127.0.0.1:3210)

## Critérios GO

- Settle Chainlink (não Binance) · logar divergência se houver
- `decisionLatencyP95MaxMs < 300`
- EV estatístico no lab — dry não substitui holdout
