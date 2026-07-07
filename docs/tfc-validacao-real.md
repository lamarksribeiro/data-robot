# Validação TFC em conta real (formato LEGO)

Plano incremental para validar a estratégia **Terminal Favorite Carry** no `data-robot`, gastando centavos e cruzando API + interface web.

## Princípios

1. **Uma peça por vez** — cada fase valida um subsistema antes de compor o próximo.
2. **Observe antes de operar** — F1 não envia ordens; F2 usa ordem a 1¢ postOnly que não executa.
3. **Mesma API key do navegador** — ordens só aparecem na UI com key derivada (`npm run derive-key:write`).
4. **Logs reproduzíveis** — scripts gravam JSONL em `runs/` para comparar com backtest.
5. **Custo máximo por teste** — micro-entrada ~$0.05; latência ~$0.05 reservado mas cancelado sem fill.

## Fases

| Fase | Comando | O que valida | Custo |
|------|---------|--------------|-------|
| **F0** | `npm run check:api-key` + `npm run test:connection` | Credenciais, saldo, Gamma | $0 |
| **F1** | `npm run tfc:watch` | RTDS BTC, CLOB bid/ask, PTB, gates TFC | $0 |
| **F2a** | `npm run tfc:latency -- --label=local` | Latência no PC (VPN) — referência | ~$0 |
| **F2b** | `npm run tfc:latency -- --label=giovanna` | Latência no servidor Coolify Giovanna — **oficial** | ~$0 |
| **F2c** | `npm run tfc:latency:compare` | Delta local vs servidor | $0 |
| **F3** | `npm run tfc:micro-entry` (dry-run) | Plano de ordem quando gates OK | $0 |
| **F3b** | `npm run tfc:micro-entry -- --live --cancel` | Ordem real mínima + cancel | ~$0 |
| **F3c** | `npm run tfc:micro-entry -- --live` | Fill real se mercado permitir | ~$0.05–0.10 |
| **F4** | (próximo) late flip / hedge stop | Saída e hedge | TBD |
| **F5** | (próximo) reverse pós flip | Lado oposto | TBD |

## F0 — Smoke de conta

```powershell
cd d:\Projetos\projeto-goldenlens\data-robot
npm run check:api-key
npm run test:connection
```

Checklist visual: saldo no site ≈ saldo na API.

## F1 — Observar janela terminal (sem ordens)

Abra o evento BTC 5m no navegador e rode em paralelo:

```powershell
npm run tfc:watch -- --terminal-only
```

O script imprime a cada 1s (só na janela 5–30s antes do fim):

- `btc` (Chainlink RTDS) vs `ptb` (price to beat)
- bid/ask UP e DOWN
- cada gate TFC (✓/✗)
- `GATES:OK` quando todos passam

Log completo: `runs/watch-<timestamp>.jsonl`

**O que comparar com backtest:**

| Variável | Backtest (tick DB) | Real (F1) |
|----------|-------------------|-----------|
| PTB | `openPrice` histórico | API `crypto-price` |
| BTC spot | tick `btc` | RTDS Chainlink |
| Ask favorito | `up_ask_1` / `down_ask_1` | CLOB WS best ask |
| OBI | 5 níveis do book | CLOB WS depth |
| `secsLeft` | derivado do evento | `eventEnd - now` |

**Sinais de problema:**

- `rtdsLagMs` > 2000 — spot atrasado vs mercado
- `clobLagMs` > 3000 — book stale na janela terminal
- gates OK no robô mas não no backtest do mesmo minuto → divergência de feed

## F2 — Latência de ordem (local + servidor)

Latência medida no PC com VPN **não** é representativa de produção. Meça nos dois ambientes e compare.

Guia completo: [latencia-local-vs-servidor.md](./operacao/latencia-local-vs-servidor.md)

**Local (referência):**

```powershell
npm run tfc:latency -- --label=local --repeat=3 --note="PC + VPN"
```

**Servidor Giovanna (oficial para calibrar TFC):**

```bash
npm run tfc:latency -- --label=giovanna --repeat=5
```

**Comparar:**

```powershell
npm run tfc:latency:compare -- --labels local,giovanna
```

Mede ping CLOB `/time`, `createAndPostOrder`, `getOpenOrders`, `cancelOrder`. Salva `runs/latency-<label>-<timestamp>.json`.

Meta no **servidor**: total < 700 ms. No local com VPN, espere valores maiores — use só para debug.

Confirme na UI (Portfolio → Open) que a ordem apareceu antes do cancel (teste local).

## F3 — Micro-entrada

**Dry-run** (padrão — nenhuma ordem):

```powershell
npm run tfc:micro-entry -- --timeout=330
```

Quando gates OK, imprime plano (lado, preço, size, notional).

**Live com cancel** (valida pipeline sem risco de fill):

```powershell
npm run tfc:micro-entry -- --live --cancel --timeout=330
```

**Live com fill** (só quando F1–F2 estáveis):

```powershell
npm run tfc:micro-entry -- --live --timeout=330
```

Acompanhe no navegador: ordem na aba Open, preço/size, execução parcial/total.

## Cruzamento API + UI

Durante qualquer fase com ordem:

1. **API** — `getOpenOrders()` deve listar a mesma ordem que a UI.
2. **UI** — Portfolio → Open; evento → Buy Up/Down.
3. **Timing** — anote delay entre log do script e aparecer na UI.

Se ordem some da API mas está na UI (ou vice-versa), volte ao [guia de API key](polymarket-ordens-abertas-ui-vs-api.md).

## Preset usado

Parâmetros em `src/tfc/preset-v6-hybrid.js` (espelho do campeão V6 Hybrid do backtest).

Gates avaliados em F1/F3:

- Janela terminal (5–30s)
- Distância |BTC − PTB| < 20
- Ask favorito 0.55–0.82
- Spread ≤ 0.03
- oddsSum 0.98–1.06
- Velocity guard (5s)
- OBI ≥ 0

Ainda **não** implementado: late flip exit, hedge stop, reverse.

## Próximos blocos LEGO (F4+)

1. **Posição aberta simulada** — após micro-fill, monitorar bid vs `stopMinBid`
2. **Hedge stop-buy** — ordem no oposto a `hedgeStopPrice` nos últimos 8s
3. **Late flip** — cruzamento PTB com `lateFlipExitSec`
4. **Reverse** — entrada no oposto após flip
5. **Relatório** — script que agrega `runs/*.jsonl` vs backtest do mesmo evento

## Referências

- Estratégia GLS: `data-backtest/src/backtestStudio/gls/strategies/TerminalFavoriteCarry.gls`
- Preset: `data-backtest/labs/strategies/terminal/tfc/presets/btc-champion-v6-hybrid.json`
- Config `.env`: [polymarket-configuracao-env.md](polymarket-configuracao-env.md)
