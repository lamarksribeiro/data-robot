# Escada Dupla / Shotandgo — dry WS

Harnesses **novos** (não alteram Pair-Path / Clip):

| Script | Uso |
|---|---|
| `ladder-dry.js` | Escada mínima 3+3 |
| `shotandgo-dry.js` | Mecânica Phil/Shotandgo (+ `--cruel`) |
| `shotandgo-micro-live.js` | Micro com travas; default dry; `--live` = $$ |

## Dry cruel (recomendado agora)

```powershell
cd d:\Projetos\projeto-goldenlens\data-robot
npm run escada:shotandgo-dry -- --profile=hybrid --cruel --max-events=3 --min-tau-start=180
npm run escada:shotandgo-micro -- --max-events=1 --min-tau-start=180

# Giovanna
ssh Giovanna 'docker exec pair-path-micro node scripts/escada-dupla/shotandgo-dry.js --profile=hybrid --cruel --max-events=3 --min-tau-start=180 --poll-ms=50'
```

Cruel = slip +1¢ · depth do book · latência 80ms · EQ parcial (mata mop-up @4¢ fake).

### Profiles

| Profile | Grade | MULT | maxVir | EQ / extras |
|---|---|---|---|---|
| **hybrid** | SUB 55/60/65 · DESC 40/36/32 | 1 | 2 | avgSum≤0.94 · open-ready · escape τ20 |
| tuned | Phil 10+10 | 1 | 3 | avgSum≤0.98 |
| phil | Phil 10+10 | 2…8+contagio | 20 | equaliza caro |
| clip | 55/60/65 · 45/40/35 | 1 | 2 | gate 0.98 |

### Micro-live (WS max speed)

Mínimo: SUB taker → DESC resting → EQ/escape. Tick no `onUpdate` do WS + poll 10ms.

```powershell
# dry
npm run escada:shotandgo-micro -- --max-events=1 --min-tau-start=180
# LIVE (min 5sh, notional≤$8 — CLOB não aceita size&lt;5)
npm run escada:shotandgo-micro -- --live --max-events=1 --min-tau-start=180
```

Travas: shares≥5 · notional default $8 · cancelAll no fim/SIGINT.

## Deploy container

```powershell
ssh Giovanna 'rm -rf /tmp/escada-dupla'
scp -P 2222 -r d:\Projetos\projeto-goldenlens\data-robot\scripts\escada-dupla root@65.21.146.77:/tmp/escada-dupla
ssh Giovanna 'docker exec pair-path-micro rm -rf /usr/src/app/scripts/escada-dupla ; docker cp /tmp/escada-dupla pair-path-micro:/usr/src/app/scripts/escada-dupla'
```
