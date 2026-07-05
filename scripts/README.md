# Scripts CLI — data-robot

Ferramentas operacionais antes do servidor do robô estar completo.

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
