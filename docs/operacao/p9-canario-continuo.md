# P9 — serviço MIDAS canário

**Escopo:** BTC Up/Down 5m, `midas-carry-v1@1.0.0`, preset `btc-champion-v1`, uma instância e uma entrada por janela de 24h. `REVERSE` live permanece bloqueado.

## O que foi implementado

- runner long-lived no processo `engine:serve` com source BTC 5m;
- preflight real fail-closed antes de iniciar o runtime live;
- User WS + REST reconcile + heartbeat/cancel-on-disconnect;
- hard cap de **$2** por ordem/evento e uma entrada por janela, persistidos no checkpoint;
- catálogo versionado por strategy/version/preset/`marketScope`;
- halt protetivo na rotação caso ainda exista posição sem settlement reconciliado;
- audit JSONL e checkpoints fora de `/tmp`;
- dashboard autenticado, proxy interno e kill switch;
- suite local `npm run p9:readiness`.

## Variáveis da Engine

### Primeiro deploy — shadow MIDAS

```env
ENGINE_MODE=shadow
ENGINE_LIVE_ENABLED=0
ENGINE_CANARY_MODE=1
ENGINE_STRATEGY_ID=midas-carry-v1
ENGINE_STRATEGY_INSTANCE_ID=midas-carry-v1:btc5m:primary
ENGINE_SNAPSHOT_SOURCE=btc5m
ENGINE_CANARY_MAX_BUDGET=2
ENGINE_CONTROL_WINDOW_MS=86400000
ENGINE_STATE_DIR=/data
STRATEGY_CATALOG_PATH=config/strategy-catalog.json
SOURCE_COMMIT=<sha-do-deployment>
```

O volume persistente deve montar `/data`. Cada modo/instância usa um subdiretório próprio em `/data/instances`; checkpoints incompatíveis de outra estratégia, instância ou modo são recusados. Validar `/health`, `/ready`, `/status`, rotação e escrita de audit/checkpoints.

### Promoção supervisionada — live

Alterar somente após aprovação humana do shadow:

```env
ENGINE_MODE=live
ENGINE_LIVE_ENABLED=1
ENGINE_CANARY_MODE=1
```

Credenciais CLOB, `ENGINE_OPS_TOKEN` e demais secrets permanecem exclusivamente no serviço da Engine.

## Variáveis da UI

```env
ENGINE_INTERNAL_URL=http://<dns-interno-da-engine>:3201
ENGINE_OPS_TOKEN=<mesmo-token-da-engine>
DASHBOARD_USER=<operador>
DASHBOARD_PASSWORD=<senha-longa>
NODE_ENV=production
```

Sem usuário/senha configurados, o login falha fechado. O token da Engine nunca é enviado ao browser.

## Gates antes do primeiro start live permanente

1. `npm run ci` e `npm run p9:readiness` verdes no commit exato.
2. Catálogo retorna `canary-approved` para MIDAS/BTC 5m.
3. Shadow long-lived escreve checkpoint e audit no volume persistente.
4. Dashboard mostra commit, strategy, aprovação, mercado, posição, ordens e saúde.
5. Kill switch pelo dashboard leva a Engine a `HALTED` e cancela ordens abertas.
6. Confirmar que o commit mostrado em `/status` é o mesmo deployado pelo Coolify.

## Gates que ainda exigem mercado real

- late-flip EXIT CLOB real reconciliado;
- partial fill seguido de cancel/reconcile real, sem duplicar posição;
- restart com ordem/posição real pré-existente e recovery antes de `ARMED`;
- cancel-on-disconnect real e ausência sustentada de órfãs;
- 10 entradas supervisionadas em dias distintos, shadow ≥100 e soak ≥7 dias para a promoção contínua plena;
- 50 eventos ou 7 dias por degrau antes de aumentar budget.

Até essas evidências existirem, o serviço é **canário supervisionado**, não autonomia 24/7.
