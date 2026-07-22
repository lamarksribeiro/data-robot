# Evidência — MIDAS shadow sprint ≥5 ENTER

**Data:** 22/07/2026  
**Host:** Giovanna (`data-robot-engine` `rx06uazamupj1w98pvl2b1d9`)  
**Estratégia:** `midas-carry-v1` / preset `btc-champion-v1` (`MIDAS_V1`)  
**Modo:** shadow (sem ordem CLOB)  
**Commits relevantes:** `e77f3a4` (seed REST CLOB) → `b1496ee` (reset engine por mercado)

## Resultado

| Campo | Valor |
|-------|--------|
| Gate ágil | **PASS** |
| Target | 5 ENTER |
| Count | **5** |
| `ok` | `true` |
| `timedOut` | `false` |
| Intervalo poll | 50 ms |
| `ENGINE_SOURCE_INTERVAL_MS` (engine fixture) | 100 |

### ENTER reconciliados (sprint aprovado)

| # | Side | Ask | τ (s) | Qty | Budget | Evento (ET) | marketId | UTC |
|---|------|-----|-------|-----|--------|-------------|----------|-----|
| 1 | UP | 0.71 | 28.4 | 14 | ~10.22 | 10:35–10:40 | `btc-updown-5m-1784730900` | 14:39:31Z |
| 2 | UP | 0.70 | 29.3 | 14 | 10.08 | 10:40–10:45 | `btc-updown-5m-1784731200` | 14:44:30Z |
| 3 | UP | 0.87 | 29.6 | 17 | 15.13 | 10:45–10:50 | `btc-updown-5m-1784731500` | 14:49:30Z |
| 4 | UP | 0.84 | 5.7 | 17 | 14.62 | 10:50–10:55 | `btc-updown-5m-1784731800` | 14:54:54Z |
| 5 | DOWN | 0.71 | 30.0 | 14 | ~10.22 | 11:05–11:10 | `btc-updown-5m-1784732700` | 15:09:30Z |

Sprint aprovado: ~14:34Z → 15:09Z (~35 min após o fix de rotação).

## Artefatos no volume (Giovanna)

Montagem: `rx06uazamupj1w98pvl2b1d9-engine-runs` → `/usr/src/app/runs`.

| Arquivo | Conteúdo |
|---------|----------|
| `/usr/src/app/runs/midas-shadow/sprint-20260722T143455Z.log` | log completo + JSON `resultado` |
| `/usr/src/app/runs/midas-shadow/sprint-20260722T143455Z.done` | resumo |
| `/usr/src/app/runs/midas-shadow/LAST.done` | cópia do resumo (consulta rápida) |
| `/usr/src/app/runs/midas-shadow/READY` | marker `ready` |
| `/usr/src/app/runs/midas-shadow/archive-overnight-1enter.log` | corrida overnight (pré-fix) |

Consulta:

```bash
ssh Giovanna
CID=$(docker ps | awk '/rx06uazamupj1w98pvl2b1d9/{print $NF; exit}')
docker exec "$CID" cat /usr/src/app/runs/midas-shadow/LAST.done
docker exec "$CID" grep '^\[ENTER' /usr/src/app/runs/midas-shadow/sprint-20260722T143455Z.log
```

Harness local / container:

```bash
npm run midas:shadow-sprint -- --target=5 --timeout=28800 --interval=50
# persistido no Giovanna via scripts/midas/giovanna-shadow-persist.sh
```

## Overnight (pré-fix) — 22/07 ~07:51Z–14:33Z

- Duração ~6,5 h; **81** rotações de evento; **1881** amostras `[term]`.
- **1 ENTER** apenas (4:10–4:15AM ET, DOWN ask 0.89).
- Depois disso o log mostrou dezenas de `ok=1 all-pass` **sem** novo ENTER.

### Causa raiz

O plugin só emite ENTER com `position.qty <= 0`. No shadow, o fill simulado abria posição e a engine **não** zerava na rotação de mercado → sprint ficava preso em 1/5.

### Correção

`scripts/midas/shadow-sprint.js` (`b1496ee`): em cada novo `conditionId`, `safeShutdown` + nova engine shadow (posição limpa). Contagem continua 1 ENTER por `marketId`.

## Outros fixes operacionais (mesma sessão)

| Item | Motivo |
|------|--------|
| Poll 50 ms + heartbeat/gates 1 s | não operar às cegas; capturar janela 5–30 s |
| Retry PTB a cada 2 s | PTB null no open do slot |
| Staleness shadow RTDS 8 s / CLOB 15 s | livro quieto noturno marcava `healthy=0` |
| Seed REST `/book` após subscribe | WS conectado com ask vazio pós-rotação |
| Reconnect RTDS/CLOB 500 ms | recuperação mais rápida |
| `ENGINE_SOURCE_INTERVAL_MS=100` | engine fixture mais ágil no Coolify |

## Gates que mais falharam (overnight / diurno)

Ordem aproximada de frequência nos `[term]`:

1. `askBand` (ask favorito > `maxAsk` 0.94 — mercado “já decidido”)
2. book/`ask` indisponível (antes do seed REST)
3. `obi` (`minObi=0` → OBI negativo bloqueia)
4. `distance` (`maxDistAbs=40`)
5. `velocity` / `oddsSum` / `spread`

Isso é comportamento do champion, não falha de infra.

## Próximo gate

1. ~~Shadow ≥5 ENTER~~ **feito 22/07**
2. **3×** `midas:micro-live -- --live` cap **$1** (ENTER → fill reconciliado → hold até resolução)
3. EXIT/danger live antes de subir budget / P9

Nenhuma ordem real foi enviada nesta evidência de shadow.
