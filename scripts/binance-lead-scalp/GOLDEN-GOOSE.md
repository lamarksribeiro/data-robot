# e-golden V2 — o pato dos ovos de ouro

**Data:** 2026-08-05 (V2: impulseCap=20, rescueStop=0.25)  
**Default:** `--variant=e-golden` (dry + live + npm scripts)

> **Status canônico:** `e-golden` é o candidato principal de pesquisa/shadow, não uma autorização de live. A decisão completa, os gates e as rejeições estão em [`docs/ESTRATEGIA-MESTRA-BTC5M-2026-08-04.md`](../../docs/ESTRATEGIA-MESTRA-BTC5M-2026-08-04.md). Spec V2: `data-backtest/docs/estrategias/estrategia-definitiva-btc-5m-golden-v2-2026-08-05.md`.

---

## Tese em uma frase

Há **evidência de edge no replay** (WR ~80%, PF ~4,7 na V2, dezenas de milhares de trades), ainda não prova de edge líquido ao vivo.  
O que matava o live não era a falta de alpha — era **sizing assimétrico em ask barato** + **rescue maker depois de gap de desastre**.

---

## O que NÃO mudamos (já é ouro)

| Peça | Por quê |
|---|---|
| Lead Binance 2s | Edge de latência spot → book Polymarket |
| Impulso adaptativo 2.5σ | Escala com vol; lab GO |
| Ladder maker +8¢/+14¢ | Fonte de lucro (ladder_full) |
| Rescue maker entry+1¢ | Recupera soft-stop sem fee |
| minTau=20 | Subir para 60 **corta PnL −8.8%** (lab A/B) |
| sharesCap@0.50 | Evita oversize em ask barato (forense −$1.20) |
| immediateDisasterDump | Não postar rescue após gap |

---

## O que mudamos na V2 (vs V1)

| Peça | V1 | **V2** | Motivo |
|---|---|---|---|
| `impulseCap` | $12 | **$20** | Mais seletivo; −14% trades, WR +3,6pp |
| `rescueStop` | $0.15 | **$0.25** | Menos dumps prematuros; DD −56% |

Lab sharesCap b5, 92d (mai–jul):

| | PnL | PF | maxDD | WR |
|---|---:|---:|---:|---:|
| V1 (cap12/ds25) | +$20.077 | 3,66 | $32,22 | 76,8% |
| **V2 (cap20/ds25)** | **+$20.095** | **4,71** | **$14,26** | **80,4%** |

### `sharesCap @ 0.50`

```
shares = min(budget / ask, floor(budget / 0.50))
```

| budget | ask 0.34 sem cap | com cap | max $ loss @ −25¢ |
|---:|---:|---:|---:|
| $3 | 8.8 sh | **6 sh** | $1.50 |
| $5 | 14.7 sh | **10 sh** | $2.50 |
| $10 | 29.4 sh | **20 sh** | $5.00 |

### 2. Immediate disaster dump

Se `bid ≤ entry − rescueStop` **antes** de estar em rescue:

- engine: `managePosition` → `rescue_stop` (sem `enterRescue`)
- live: `willDump=true`, `willRescue=false` (não posta maker inútil)

Isso fecha o gap do forense: soft-stop → post rescue → bid já em 0.18 → dump atrasado.

### 3. Defaults de produção

| | e-adapt (legado) | **e-golden V2** |
|---|---|---|
| sizing | none | **sharesCap@0.50** |
| impulseCap | 12 | **20** |
| rescueStop (engine) | 0 | **0.25** |
| immediateDisasterDump | true (base) | **true** |
| default CLI | antigo | **novo default** |

---

## Como rodar

```powershell
# dry local / Giovanna
npm run scalp-e:dry
# ou
node scripts/binance-lead-scalp/scalp-dry.js --variant=e-golden --max-events=12

# micro live (só com autorização explícita — ver Estratégia Mestra)
npm run scalp-e:live -- --live --budget=5 --max-events=8 `
  --max-session-notional=40 --max-session-loss=8 --rescue-stop=0.25
```

Testes: `node --test test/binance-lead-scalp-engine.test.js`

---

## O que NÃO é o pato (armadilhas)

1. **rescueStop=0 no live** — lab PF 19 é irreal se um trade vai a zero.  
2. **Subir minTau** — lab rejeitou.  
3. **Perseguir max PnL paper sem cap** — a assimetria do ask barato vira ruína em micro.  
4. **Ladder curta +1/+2/+3¢** — lab full-B negativo / near-zero.  
5. **Esperar win $ > loss $ em cada trade** — edge é WR alta + muitos ladder_full; disasters ainda doem em ¢, o cap limita em $.
6. **Reverter para impulseCap=12 / ds15 sem lab** — V2 domina V1 em PF e DD; regressão só com evidência nova.

---

## Próximos ovos (backlog)

1. Dry 24–48 / 100 eventos na Giovanna com e-golden V2 (fill=cruel).  
2. OOS em dados de agosto (pós-31/07) antes de micro.  
3. Micro live $5 × 8 eventos com caps de sessão — **só com autorização**.  
4. Lab: combinar sharesCap + liqCap (entry quality) se depth real for thin.  
5. Ladder weight 70/30 no +8¢ (não validado — só se dry mostrar underfill no +14).

---

## Arquivos

| Path | Mudança |
|---|---|
| `scalp-engine.js` | `VARIANT_E_GOLDEN` V2, `sizeShares`, pre-dump em `managePosition` |
| `scalp-dry.js` / `scalp-live.js` | default e-golden V2, flags sizing/cap/dump |
| `test/binance-lead-scalp-engine.test.js` | unit tests V2 |
| `README.md` | ops e-golden V2 |
| `package.json` | npm scripts |
