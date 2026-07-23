# P9 — serviço MIDAS canário

**Escopo:** BTC Up/Down 5m, `midas-carry-v1@1.0.0`, preset `btc-micro-aggressive-v1` (Aggressive dist 40 + tier 2.0× + sizing micro `$2`/`$4`), uma instância e uma entrada por janela de 24h. **REVERSE live habilitado** via saga `SELL → reconcile → BUY`.

## O que foi implementado

- runner long-lived no processo `engine:serve` com source BTC 5m;
- preflight real fail-closed antes de iniciar o runtime live;
- User WS + REST reconcile + heartbeat/cancel-on-disconnect;
- hard cap de **$4** por ordem/evento (= `maxEntryBudget` do micro Aggressive; tier 2.0× intacto) e uma entrada por janela, persistidos no checkpoint;
- saga REVERSE: SELL da posição → flat → BUY no lado oposto (FAK);
- catálogo versionado por strategy/version/preset/`marketScope`;
- halt protetivo na rotação caso ainda exista posição sem settlement reconciliado;
- audit JSONL e checkpoints fora de `/tmp`;
- dashboard autenticado, proxy interno, catálogo, auditoria e control plane completo;
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
ENGINE_CANARY_MAX_BUDGET=4
ENGINE_CONTROL_WINDOW_MS=86400000
ENGINE_STATE_DIR=/data
ENGINE_START_ARMED=0
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
Mesmo depois do processo iniciar saudável, live permanece `DISARMED` até o operador executar **Armar**. Esse comando refaz preflight live, readiness e reconciliação antes de liberar `ENTER`/`REVERSE`.

## Capital (wallet ~US$ 34)

| Item | Valor |
|---|---|
| ENTER base | $2 |
| ENTER high-ask (tier 2.0×) | $4 |
| Hard cap / daily loss | $4 (~12% da wallet) |
| Reverse | sequencial — pico USDC no BUY ≈ $4, não $8 |
## Variáveis da UI

```env
ENGINE_INTERNAL_URL=http://<dns-interno-da-engine>:3201
ENGINE_OPS_TOKEN=<mesmo-token-da-engine>
DASHBOARD_USER=<operador>
DASHBOARD_PASSWORD=<senha-longa>
NODE_ENV=production
```

Sem usuário/senha configurados, o login falha fechado. O token da Engine nunca é enviado ao browser.

## Estados e ações do painel

O estado interno da Engine e o estado do operador são campos separados. A Engine pode continuar `ARMED` internamente para processar snapshots e saídas, enquanto o operador mantém novas entradas bloqueadas.

| Ação | Efeito |
|---|---|
| **Armar** | Revalida dependências/recovery e libera novas entradas. Live continua fail-closed se qualquer gate falhar. |
| **Pausar** | Bloqueia `ENTER`/`REVERSE`, cancela entradas abertas e mantém feed, reconciliação e `EXIT`. |
| **Parar entradas** | Mesmo bloqueio protetivo da pausa, registrando a instância como `DISARMED`. |
| **Reconciliar** | Compara OMS e exchange; qualquer órfã ou pendência mantém a instância desarmada. |
| **Checkpoint** | Persiste estado da estratégia, posição, risk e journal. |
| **Cancelar ordens** | Desarma e cancela todas as ordens abertas, inclusive exits resting. |
| **Zerar posição** | Desarma, cancela entradas e envia `EXIT FAK` da posição consolidada com preço protegido pelo book atual. |
| **Rollback** | Só funciona desarmado e sem ordens abertas; restaura o último checkpoint, reinicia o runtime e reconcilia. |
| **Kill switch** | Vai para `HALTED`, cancela ordens e exige restart do processo para recuperação. |

Todas as mutações exigem sessão, confirmação explícita no browser e `ENGINE_OPS_TOKEN` no salto UI → Engine. A Engine também valida a confirmação. Ações, falhas e resultados são gravados no audit JSONL e exibidos pelo painel.

Endpoints internos da Engine: `POST /control/arm`, `/pause`, `/stop`, `/reconcile`, `/checkpoint`, `/cancel-all`, `/flatten`, `/rollback` e `/kill`; leituras adicionais em `GET /instances`, `/catalog` e `/audit`.

## Instâncias BTC 5m e ETH 5m

O painel atual controla uma instância imutável por processo. BTC 5m e ETH 5m são instâncias diferentes, com `strategyInstanceId`, feed, posição, journal e checkpoint próprios. O catálogo pode mostrar todos os plugins aprovados, mas não troca estratégia a quente.

Multi-live simultâneo na mesma conta ainda exige o supervisor/coordenador global e durável descrito no ADR-002. Até esse gate existir, processos independentes podem coexistir em shadow, mas não devem disputar capital live da mesma conta.

## Gates antes do primeiro start live permanente

1. `npm run ci` e `npm run p9:readiness` verdes no commit exato.
2. Catálogo retorna `canary-approved` para MIDAS/BTC 5m.
3. Shadow long-lived escreve checkpoint e audit no volume persistente.
4. Dashboard mostra commit, strategy, aprovação, mercado, posição, ordens, instância, catálogo, audit e saúde.
5. Ensaiar `arm → pause → stop → reconcile → checkpoint → rollback` sem ordem real.
6. Kill switch pelo dashboard leva a Engine a `HALTED` e cancela ordens abertas.
7. Confirmar que o commit mostrado em `/status` é o mesmo deployado pelo Coolify.

## Gates que ainda exigem mercado real

- late-flip EXIT CLOB real reconciliado;
- partial fill seguido de cancel/reconcile real, sem duplicar posição;
- restart com ordem/posição real pré-existente e recovery antes de `ARMED`;
- cancel-on-disconnect real e ausência sustentada de órfãs;
- 10 entradas supervisionadas em dias distintos, shadow ≥100 e soak ≥7 dias para a promoção contínua plena;
- 50 eventos ou 7 dias por degrau antes de aumentar budget.

Até essas evidências existirem, o serviço é **canário supervisionado**, não autonomia 24/7.
