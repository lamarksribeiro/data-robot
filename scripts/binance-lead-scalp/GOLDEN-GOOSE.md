# e-golden — o pato dos ovos de ouro

**Data:** 2026-08-04  
**Default:** `--variant=e-golden` (dry + live + npm scripts)

> **Status canônico:** `e-golden` é o candidato principal de pesquisa/shadow, não uma autorização de live. A decisão completa, os gates e as rejeições estão em [`docs/ESTRATEGIA-MESTRA-BTC5M-2026-08-04.md`](../../docs/ESTRATEGIA-MESTRA-BTC5M-2026-08-04.md). “Default” aqui significa default de implementação/teste.

---

## Tese em uma frase

Há **evidência de edge no replay** (WR ~75%, PF ~3, dezenas de milhares de trades), ainda não prova de edge líquido ao vivo.  
O que matava o live não era a falta de alpha — era **sizing assimétrico em ask barato** + **rescue maker depois de gap de desastre**.

---

## O que NÃO mudamos (já é ouro)

| Peça | Por quê |
|---|---|
| Lead Binance 2s | Edge de latência spot → book Polymarket |
| Impulso adaptativo 2.5σ ∈[$5,$12] | Escala com vol; lab GO |
| Ladder maker +8¢/+14¢ | Fonte de lucro (ladder_full avg +$2.51 lab $10) |
| Rescue maker entry+1¢ | Recupera soft-stop sem fee |
| minTau=20 | Subir para 60 **corta PnL −8.8%** (lab A/B) |
| rescueStop=0.15 live | Sem isso, hold até settlement = −100% notional |

---

## O que mudamos (e-golden)

### 1. `sharesCap @ 0.50`

```
shares = min(budget / ask, floor(budget / 0.50))
```

| budget | ask 0.34 sem cap | com cap | max $ loss @ −15¢ |
|---:|---:|---:|---:|
| $3 | 8.8 sh | **6 sh** | $0.90 (antes ~$1.33+) |
| $10 | 29.4 sh | **20 sh** | $3.00 (antes ~$4.40) |

Lab cap50 vs baseline (mai–jul $10):

| | PnL | PF | maxDD |
|---|---:|---:|---:|
| baseline | +50.7k | 3.06 | 127 |
| **cap50** | +37.0k | **3.12** | **89** |

Troca consciente: **menos PnL paper, melhor cauda e simetria $** — o que importa em conta real com amostra pequena.

### 2. Immediate disaster dump

Se `bid ≤ entry − rescueStop` **antes** de estar em rescue:

- engine: `managePosition` → `rescue_stop` (sem `enterRescue`)
- live: `willDump=true`, `willRescue=false` (não posta maker inútil)

Isso fecha o gap do forense: soft-stop → post rescue → bid já em 0.18 → dump atrasado.

### 3. Defaults de produção

| | e-adapt (legado) | **e-golden** |
|---|---|---|
| sizing | none | **sharesCap@0.50** |
| rescueStop (engine) | 0 | **0.15** |
| immediateDisasterDump | true (base) | **true** |
| default CLI | antigo | **novo default** |

---

## Como rodar

```powershell
# dry local / Giovanna
npm run scalp-e:dry
# ou
node scripts/binance-lead-scalp/scalp-dry.js --variant=e-golden --max-events=12

# micro live
npm run scalp-e:live -- --live --budget=5 --max-events=8 `
  --max-session-notional=40 --max-session-loss=8 --rescue-stop=0.15
```

Testes: `node --test test/binance-lead-scalp-engine.test.js`

---

## O que NÃO é o pato (armadilhas)

1. **rescueStop=0 no live** — lab PF 19 é irreal se um trade vai a zero.  
2. **Subir minTau** — lab rejeitou.  
3. **Perseguir max PnL paper sem cap** — a assimetria do ask barato vira ruína em micro.  
4. **Ladder curta +1/+2/+3¢** — lab full-B negativo / near-zero.  
5. **Esperar win $ > loss $ em cada trade** — edge é WR alta + muitos ladder_full; disasters ainda doem em ¢, o cap limita em $.

---

## Próximos ovos (backlog, não bloqueantes)

1. Dry 24–48 eventos na Giovanna com e-golden (fill=cruel) vs e-adapt.  
2. Micro live $5 × 8 eventos com caps de sessão.  
3. Lab: combinar sharesCap + liqCap (entry quality) se depth real for thin.  
4. Ladder weight 70/30 no +8¢ (não validado — só se dry mostrar underfill no +14).  
5. Sizing por risco $ fixo (`maxLoss = shares * rescueStop`) se quiser simetria ainda mais rígida.

---

## Arquivos

| Path | Mudança |
|---|---|
| `scalp-engine.js` | `VARIANT_E_GOLDEN`, `sizeShares`, pre-dump em `managePosition` |
| `scalp-dry.js` / `scalp-live.js` | default e-golden, flags sizing/cap/dump |
| `test/binance-lead-scalp-engine.test.js` | unit tests |
| `README.md` | ops e-golden |
| `package.json` | npm scripts |
