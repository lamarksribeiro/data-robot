# Late Surprise — dry WS (Giovanna)

Harness **dry/shadow** da variante `m3-ask35` (lab `late-cheap-flip-v1`).
WS CLOB + RTDS · fill simulado · **zero ordens**.

| Script | Uso |
|---|---|
| `late-surprise-sprint.js` | **Fase 1 acelerada** (multi-asset + target-windows) |
| `late-surprise-dry.js` | Dry longo BTC-only (legado) |
| `late-surprise-engine.js` | Sinal + settle |

## Params campeão

- τ 3–15s · ask ≤ 0,35 · edge ≥ 0,12 · dist ≥ $8 · hold to settlement
- Budget default $10 · fee taker `0.07·p·(1−p)` · settle 0,995

## Fase 1 acelerada (não esperar 10–12 dias)

O sinal é **raro por desenho** (~10 ENTERs/dia no BTC). EV estatístico vem do lab;
ao vivo só validamos plumbing + latência.

| Gate | Como | Tempo |
|---|---|---|
| **A · EV** | lab holdout + recent-window (já feito, PF 1,74) | minutos |
| **B · Plumbing** | sprint `--probe --target-windows=24` · 4 ativos | **~30–40 min** |
| **C · Latência** | `decisionLatencyMs.p95 < 300` no summary | incluso |
| **D · Enters** | bônus se aparecerem; não bloqueiam o GO | — |

Sprint sai quando `windowsSeen ≥ 24` **ou** `enters ≥ 15`.

```powershell
# Local
npm run late-surprise:sprint -- --probe --target=15 --target-windows=24 --assets=btc,eth,sol,xrp

# Giovanna
scp -P 2222 d:\Projetos\projeto-goldenlens\data-robot\scripts\late-surprise\late-surprise-sprint.js root@65.21.146.77:/tmp/late-surprise-sprint.js
scp -P 2222 d:\Projetos\projeto-goldenlens\data-backtest\labs\sandbox\late-surprise\restart-sprint.sh root@65.21.146.77:/tmp/restart-sprint.sh
cmd /c ssh Giovanna "bash /tmp/restart-sprint.sh"
cmd /c ssh Giovanna "docker exec pair-path-micro tail -f /tmp/late-surprise-sprint.log"
```

## Critérios GO → micro

- Gate A: lab PF ≥ 1,15 na janela recente ✓
- Gate B: `okPlumbing=true` (24 janelas, bookFresh > bookStale, p95 < 300ms)
- Gate D (opcional): alguns ENTERs champion antes do micro $2

Reports: `runs/late-surprise-sprint-probe/` no container.
