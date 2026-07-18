# Configuração correta do `.env` — Polymarket CLOB

Guia prático para configurar o `data-robot` sem o problema de ordens invisíveis na UI. Leia primeiro o [achado sobre API keys](./polymarket-ordens-abertas-ui-vs-api.md).

---

## Variáveis obrigatórias

| Variável | Descrição |
|----------|-----------|
| `POLYMARKET_PRIVATE_KEY` | Chave privada EOA (`0x...`) exportada da conta Polymarket |
| `POLYMARKET_API_KEY` | Credencial L2 — **preferir derivada** (ver abaixo) |
| `POLYMARKET_API_SECRET` | Secret L2 |
| `POLYMARKET_API_PASSPHRASE` | Passphrase L2 |
| `POLYMARKET_SIGNATURE_TYPE` | `1` para email/Magic; `2` Safe; `3` deposit wallet V2 |
| `POLYMARKET_FUNDER_ADDRESS` | Endereço do perfil (proxy) — **não** o EOA |

### Exemplo (valores fictícios)

```env
POLYMARKET_PRIVATE_KEY=0x...
POLYMARKET_API_KEY=<REVOKED_POLYMARKET_L2_KEY>
POLYMARKET_API_SECRET=...
POLYMARKET_API_PASSPHRASE=...
POLYMARKET_SIGNATURE_TYPE=1
POLYMARKET_FUNDER_ADDRESS=0x6dd3DA3e37765ED4dC0d4856aCdd916B797eeda2
```

---

## Passo a passo — primeira configuração

### 1. Obter a chave privada

- Login Polymarket via email/Magic → exportar chave privada (settings / wallet export)
- Essa chave é o **signer** EOA

### 2. Descobrir o funder (proxy)

Opções:

- Site: [polymarket.com/settings](https://polymarket.com/settings) → endereço do perfil
- API: `GET https://gamma-api.polymarket.com/public-profile?address=<qualquer-endereço-da-conta>`
  - Campo `proxyWallet`

Defina `POLYMARKET_FUNDER_ADDRESS` = `proxyWallet`.

### 3. Definir signature type

| Como você entra na Polymarket | `POLYMARKET_SIGNATURE_TYPE` |
|------------------------------|----------------------------|
| Email / Google / Magic Link | `1` |
| Carteira + Safe (legado) | `2` |
| Deposit wallet V2 (contrato no funder) | `3` |

Para verificar se o funder é contrato (deposit wallet):

```bash
# bytecode > 0 → contrato; considerar type 3
curl -s -X POST https://polygon-rpc.com \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_getCode","params":["0xSEU_FUNDER","latest"]}'
```

### 4. Gerar credenciais L2 (forma correta)

```bash
cd data-robot
cp .env.example .env
# Preencher POLYMARKET_PRIVATE_KEY e POLYMARKET_FUNDER_ADDRESS

npm run derive-key:write
```

Isso grava no `.env` a **mesma API key** que o site cria no login (nonce 0).

### 5. Validar

```bash
npm run test:order -- --live --price 0.01 --size 5 --wait 15 --cancel
```

Abra [polymarket.com/portfolio?tab=open](https://polymarket.com/portfolio?tab=open) durante os 15s e confirme a ordem. O mesmo processo a cancela ao final; não rode um segundo comando, pois ele criaria outra ordem em vez de cancelar a primeira.

---

## O que NÃO fazer

| Ação | Risco |
|------|-------|
| `derive-key --create` sem necessidade | Nova API key → ordens **não** aparecem no site |
| `derive-key:rotate-new` em produção | Mesmo efeito até realinhar browser ou `.env` |
| Omitir `POLYMARKET_FUNDER_ADDRESS` com type `1` | Ordens podem ir para EOA; saldo/UI inconsistentes |
| Commitar `.env` | Vazamento de chave privada e L2 |
| Commitar `polymarket-web-api/storage/*.json` | Contém credenciais L2 do browser |

---

## Sincronizar robô após login novo no browser

Se você limpou cookies ou fez login em outro PC:

1. O browser pode regenerar credenciais em `poly_clob_api_key_map`
2. Re rode no servidor do robô:

```bash
npm run derive-key:write
```

3. Reinicie o processo do robô

Na maioria dos casos a key derivada (nonce 0) permanece estável para a mesma chave privada; só revalide se a UI parar de mostrar ordens de novo.

---

## Colateral: pUSD

O CLOB v2 opera com **pUSD**, não USDC.e direto. Saldo disponível deve ser lido via API:

```javascript
client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL })
// balance / 1e6 = pUSD
```

Se saldo = 0 com type/funder corretos, verifique wrap de USDC.e → pUSD na Polymarket.

---

## Autenticação L2 — erros comuns

| Erro | Causa provável |
|------|----------------|
| `401 Unauthorized` | Timestamp/HMAC; aguardar e retry; verificar secret/passphrase |
| `401` persistente | Key revogada — derivar de novo (não criar à toa) |
| Ordem aceita, UI vazia | **API key diferente da do browser** (ver doc principal) |
| `INVALID_ORDER_NOT_ENOUGH_BALANCE` | pUSD insuficiente ou reservado em outras ordens |

O robô usa `useServerTime: true` e sincroniza via `GET /time` — manter assim.

---

## Checklist antes de cada sessão de trading

```
[ ] .env tem POLYMARKET_FUNDER_ADDRESS = proxyWallet do perfil
[ ] POLYMARKET_SIGNATURE_TYPE correto para o tipo de login
[ ] POLYMARKET_API_KEY prefixo = key no browser (DevTools → poly_clob_api_key_map)
[ ] Saldo pUSD > mínimo operacional
[ ] derive-key --derive-only confere com .env (opcional, mensal)
[ ] Geoblock no host de execução retorna blocked=false
[ ] Teste smoke: 1 ordem postOnly pequena + visível em Open (dev)
```

O preflight de geoblock deve usar `GET https://polymarket.com/api/geoblock` a partir do host que realmente enviará as ordens. O plano prevê automatizar esse bloqueio no startup da engine.

---

## Ferramentas de diagnóstico no ecossistema

| Ferramenta | Uso |
|------------|-----|
| `polymarket-robot/scripts/place-dual-cent-orders.js` | Teste real UP/DOWN com relatório JSON |
| `polymarket-robot/test/test-cent-orders.js --live` | Bateria completa |
| `polymarket-web-api` | Login manual; `GET /api/account/wallet`; fetch autenticado no browser |
| Gamma / Data API | Perfil e posições por endereço funder |

---

## Migração para o data-robot

Quando o código for migrado do `polymarket-robot`:

- Copiar esta pasta `docs/` como referência canônica
- Manter `.env.example` alinhado com as variáveis acima
- Implementar health check de API key vs derive no startup (recomendado)

Ver também: [README da documentação](./README.md)
