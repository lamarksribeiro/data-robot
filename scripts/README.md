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

Teste de sincronização com ordem LIMIT passiva. Exige mercado, token, lado,
preço e quantidade explícitos. O padrão é simulação somente-leitura.

```bash
npm run test:order -- --market=<condition-id> --token=<token-id> --side=BUY --price=0.01 --quantity=5

# Somente após revisar o resumo da simulação:
npm run test:order -- --market=<condition-id> --token=<token-id> --side=BUY --price=0.01 --quantity=5 --live --confirm=SEND_POLYMARKET_PASSIVE_TEST
```

Proteções live: revalidação do book no ponto de envio, `postOnly`, GTD de 120s,
marca `DATA_ROBOT_SYNC_TEST` em `metadata`, janela de conferência de 10s e
cancelamento automático. Limites fixos: 10 shares e US$ 1 de notional.
Para uma conferência visual autorizada, `--keep-open` desativa o cancelamento
automático e usa GTC. A ordem deve ser cancelada pelo operador ou encerrada com
o mercado.

## fees/maker-vs-taker.js

```bash
npm run test:fee -- --mode=both
npm run test:fee -- --mode=taker --live --size=5
npm run test:fee -- --mode=maker --live --size=5 --wait=120
```

## Engine / control plane (P5)

```bash
npm run engine:serve          # control HTTP :3201 (default shadow + fixture)
npm run engine:soak           # soak curto com fixtures
npm run engine:soak -- --duration-hours=1 --interval-ms=1000
```

`ENGINE_SNAPSHOT_SOURCE=fixture` roda determinístico e sem rede. `ENGINE_SNAPSHOT_SOURCE=btc5m` ativa descoberta/rotação do evento, PTB, RTDS e CLOB continuamente. Live exige `ENGINE_MODE=live`, `ENGINE_LIVE_ENABLED=1` **e** source `btc5m`. Fora de localhost, `ENGINE_OPS_TOKEN` é obrigatório. Ver [../docs/arquitetura/observability-p5.md](../docs/arquitetura/observability-p5.md) e [../docs/operacao/deploy-giovanna.md](../docs/operacao/deploy-giovanna.md).

## TFC V7 — validação incremental

Ver [../docs/tfc-validacao-real.md](../docs/tfc-validacao-real.md). `micro-entry` é legado; somente `micro-live` passa pelo pipeline válido de promoção. MIDAS possui harness e runner long-lived P9 fail-closed.

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
