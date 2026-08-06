# Early Favorite Rush — dry Giovanna

**Status: REJEITADA / HOLD** (auditoria causal 2026-08-05). Dry só observação.

- Auditoria: `data-backtest/reports/research/early-favorite-rush-causal-canonical-audit-2026-08-05.md`
- Lookahead: `docs/estrategias/rejeitadas/early-favorite-rush-v0-lookahead.md`
- Stack causal refeito: `data-backtest/.tmp/multi-asset-early-fav-causal-stack.json`

Labs antigos com WR~91% / +PnL eram artefato (`firstCross` reverso). **Não dimensionar capital.**

## Gate

- **Default = dry** (WS + fill simulado, zero CLOB)
- Recusa `--live`

## Container

Usar sidecar **`pair-path-micro`**. Não matar scalp-dry.

## Stack dry (pós-auditoria)

| Peça | Default | Nota causal (63d overlap) |
|------|---------|---------------------------|
| Entrada | 1º toque causal + regras por asset | hold −$23,5k WR~85% |
| Cross | `--cross=majority` | melhor mitigação (−$6,9k); ainda negativo |
| Alternativa | `--cross=quorum2` | −$14,3k |
| Disaster | `--disaster=1` → bid≤**0.15** + flips + τ≤120 | sozinho **piora**; com majority ainda um pouco pior que majority-only |

```powershell
# majority + disaster 0.15 (default)
node scripts/early-fav-rush/early-fav-rush-dry.js --budget=5 --max-events=40 --cross=majority --disaster=1

# majority sem disaster (melhor no lab causal)
node scripts/early-fav-rush/early-fav-rush-dry.js --budget=5 --cross=majority --disaster=0

# quorum2
node scripts/early-fav-rush/early-fav-rush-dry.js --budget=5 --cross=quorum2
```

## Budget

| Contexto | $/trade |
|----------|---------|
| Dry | **$5** |
| Lab | $10 |

## Dashboard

```powershell
npm run early-fav:dashboard
# http://127.0.0.1:3212
```

## Deploy Giovanna

```powershell
scp -P 2222 -r d:\Projetos\projeto-goldenlens\data-robot\scripts\early-fav-rush root@65.21.146.77:/tmp/early-fav-rush
cmd /c ssh Giovanna "docker exec pair-path-micro mkdir -p /usr/src/app/scripts && docker exec pair-path-micro rm -rf /usr/src/app/scripts/early-fav-rush && docker cp /tmp/early-fav-rush pair-path-micro:/usr/src/app/scripts/early-fav-rush"

# Não matar scalp-dry
cmd /c ssh Giovanna "docker exec -d pair-path-micro sh -c 'node scripts/early-fav-rush/early-fav-rush-dry.js --budget=5 --max-events=40 --fill=honest --cross=majority --disaster=1 --poll-ms=50 > /tmp/early-fav-rush-dry.log 2>&1'"
```

## Regras por asset

| Asset | Regra |
|-------|-------|
| BTC/SOL | 85@τ≥60 + spot |
| ETH | 85@τ≥90 + spot |
| XRP/BNB | 85@τ≥120 + spot |
| DOGE | 87@τ≥60 + spot |
| HYPE | 85@τ∈[180,240) |
