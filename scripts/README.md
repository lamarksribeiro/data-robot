# Scripts CLI — data-robot

Ferramentas operacionais antes do servidor do robô estar completo.

Roadmap: [../docs/plano-desenvolvimento.md](../docs/plano-desenvolvimento.md).  
Scripts TFC são protótipos de diagnóstico — não constituem a engine (ADR-001).

**Regra P0:** qualquer comando que poste ordem exige `--live` explícito (exit 2 se omitido).

## check-api-key-alignment.js

```bash
npm run check:api-key
npm run check:api-key -- --json
npm run check:api-key -- --browser-storage ../polymarket-web-api/storage/polymarket-storage-state.json
```

Exit `0` = OK · `1` = desalinhado · `2` = fatal

## derive-api-key.js

```bash
npm run derive-key
npm run derive-key:write
```

## test-connection.js

```bash
npm run test:connection
npm run test:connection -- --json
```

## place-test-order.js

Envia ordem UP pequena (**exige `--live`**).

```bash
npm run test:order -- --live --wait 15
npm run test:order -- --live --wait 15 --cancel
npm run test:order -- --live --price 0.01 --size 5 --no-post-only
```

## fees/maker-vs-taker.js

```bash
npm run test:fee -- --mode=both
npm run test:fee -- --mode=taker --live --size=5
npm run test:fee -- --mode=maker --live --size=5 --wait=120
```

## TFC V7 — validação incremental

Ver [../docs/tfc-validacao-real.md](../docs/tfc-validacao-real.md). `micro-entry` é legado; somente `micro-live` passa pelo pipeline válido de promoção.

| Script | npm | Descrição |
|--------|-----|-----------|
| `tfc/watch-terminal.js` | `tfc:watch` | Feeds + gates V7 (sem ordens) |
| `tfc/micro-entry.js` | `tfc:micro-entry` | Legado/diagnóstico; não usar para promoção |
| `tfc/micro-live.js` | `tfc:micro-live` | Strategy → risk → OMS → User WS/REST; live fail-closed |
| `tfc/measure-order-latency.js` | `tfc:latency` | Latência (**`--live` obrigatório**) |
| `tfc/compare-latency.js` | `tfc:latency:compare` | Compara `runs/latency-*.json` |

```bash
npm run tfc:watch -- --terminal-only
npm run tfc:latency -- --live --label=local --repeat=3
npm run tfc:latency -- --live --label=giovanna --repeat=5
npm run tfc:latency:compare
npm run tfc:micro-live
# Somente após os gates operacionais:
npm run tfc:micro-live -- --live --cancel --timeout=330
```

## Qualidade

```bash
npm run lint
npm run check:architecture
npm test
npm run ci
```
