# Scripts CLI — data-robot

Ferramentas operacionais antes do servidor do robô estar completo.

Roadmap e critérios de promoção: [../docs/plano-desenvolvimento.md](../docs/plano-desenvolvimento.md). Os scripts TFC atuais são protótipos acoplados de validação e ainda não constituem uma engine autônoma com contrato de estratégia, OMS/risk/recovery.

## check-api-key-alignment.js

Valida a causa raiz documentada em [../docs/polymarket-ordens-abertas-ui-vs-api.md](../docs/polymarket-ordens-abertas-ui-vs-api.md):

- API key do `.env` = derivada (nonce 0)?
- Funder = `proxyWallet` no Gamma?
- L2 autentica e retorna saldo?

```bash
npm run check:api-key
npm run check:api-key -- --json
npm run check:api-key -- --browser-storage ../polymarket-web-api/storage/polymarket-storage-state.json
```

Exit `0` = OK · `1` = desalinhado · `2` = fatal

## derive-api-key.js

Deriva credenciais L2 da chave privada. **Preferir `--derive-only`** (mesma key do site).

```bash
npm run derive-key
npm run derive-key:write
```

Evitar `--create` se quiser ordens visíveis na UI.

## test-connection.js

Smoke test sem ordens reais.

```bash
npm run test:connection
npm run test:connection -- --json
```

## place-test-order.js

Envia ordem UP pequena no BTC 5m ativo (**dinheiro real**).

```bash
npm run test:order -- --wait 15
npm run test:order -- --wait 15 --cancel
npm run test:order -- --price 0.01 --size 5 --no-post-only
```

## fees/maker-vs-taker.js

Compara taxa **maker** (limit postOnly) vs **taker** (cruza o book) em BTC 5m.

Ver [../docs/operacao/teste-maker-vs-taker-fee.md](../docs/operacao/teste-maker-vs-taker-fee.md).

```bash
npm run test:fee -- --mode=both
npm run test:fee -- --mode=taker --live --size=5
npm run test:fee -- --mode=maker --live --size=5 --wait=120
```

## TFC — validação incremental V7

Ver [../docs/tfc-validacao-real.md](../docs/tfc-validacao-real.md). Até o alinhamento explícito de `watch` e `micro-entry` ao preset V7, seus resultados não servem como evidência de promoção.

| Script | npm | Descrição |
|--------|-----|-----------|
| `tfc/watch-terminal.js` | `tfc:watch` | Observa feeds + gates TFC (sem ordens) |
| `tfc/measure-order-latency.js` | `tfc:latency` | Latência create/get/cancel (`--label`, `--repeat`) |
| `tfc/compare-latency.js` | `tfc:latency:compare` | Compara `runs/latency-*.json` local vs servidor |

```bash
npm run tfc:watch -- --terminal-only
npm run tfc:latency -- --label=local --repeat=3
npm run tfc:latency -- --label=giovanna --repeat=5   # no servidor Giovanna
npm run tfc:latency:compare
npm run tfc:micro-entry
npm run tfc:micro-entry -- --live --cancel
```
