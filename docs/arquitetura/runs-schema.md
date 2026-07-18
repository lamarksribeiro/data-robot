# Schema de runs e política de evidência

Artefatos locais em `runs/` documentam diagnóstico e promoção. Estão no `.gitignore` por padrão (podem conter dados de conta). Relatórios versionados devem ser **sanitizados**.

## Schema version

`schemaVersion: 1` — módulo `src/runs/schema.js`.

Envelope mínimo:

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `schemaVersion` | number | Sempre `1` neste ciclo |
| `runId` | string | Identificador único do run |
| `kind` | string | `watch` \| `latency` \| `fee` \| `micro-entry` \| … |
| `label` | string | Ex.: `local`, `giovanna` |
| `environment` | string | `local` \| `shadow` \| `canary` \| `production` |
| `strategyId` | string\|null | Ex.: `tfc-v7` |
| `strategyVersion` | string\|null | Versão do plugin |
| `presetId` | string\|null | Ex.: `btc-champion-v7` |
| `startedAt` | ISO string | Início |
| `live` | boolean | Se houve ordem real |
| `meta` | object | Host, node, notas (sem secrets) |
| `payload` | object | Dados específicos do kind |

Use `buildRunEnvelope()` + `sanitizeRunRecord()` antes de gravar ou anexar a PR/docs.

## Sanitização

`sanitizeRunRecord` / `redactValue` removem ou mascaram:

- chaves: `privateKey`, `apiSecret`, `passphrase`, `secret`, `mnemonic`, `seed`
- padrões: private keys hex `0x`+64, tokens `sk_…`

Nunca versionar: private key, API secret, passphrase, endereço completo desnecessário, saldo detalhado da conta.

## Retenção

| Local | Política |
|-------|----------|
| `runs/` no disco | Trabalho local; pode apagar após consolidar evidência |
| Git | Só relatórios sanitizados em `docs/` ou `reports/` (quando existirem) |
| Promoção P2+ | Guardar p50/p95/p99, taxas de erro e mismatches — sem credenciais |

JSONL de `tfc:watch` permanece bruto localmente; o **resumo** do run deve usar o envelope v1.
