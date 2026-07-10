# Teste real: taxa maker vs taker (Hopper 3)

Validação essencial para a Hopper 3: a estratégia assume **entrada maker** (limit resting) para **não pagar** a taxa taker de crypto da Polymarket.

## Hipótese

| Papel | Como entra | Taxa de protocolo |
|-------|------------|-------------------|
| **Maker** | Limit `postOnly` no bid (não cruza o book) | **$0** |
| **Taker** | Ordem que cruza o ask (imediata) | `shares × 0.07 × p × (1−p)` |

Fonte do modelo: `data-backtest/src/backtest/fees.js` + docs Polymarket (“makers are never charged”).

No backtest da Hopper 3, `simulateMaker: true` marca fills como `liquidity: 'maker'` e o fee engine **não cobra** esses trades.

## O que o script mede

1. Consulta book BTC 5m + `getFeeRateBps`
2. Monta plano:
   - **taker:** BUY no best ask, `postOnly=false`
   - **maker:** BUY no best bid, `postOnly=true`
3. Com `--live`, envia a ordem, espera fill, consulta `getTrades()`
4. Reporta `trader_side` (`MAKER` | `TAKER`), fee esperada e Δ saldo
5. Salva `runs/fee-<mode>-<ts>.json`

## Custo esperado (centavos)

Com `size=5` e preço ~0.50:

- Notional ≈ **$2.50**
- Fee taker esperada ≈ `5 × 0.07 × 0.5 × 0.5` = **$0.0875**
- Maker: notional similar, fee **$0** (se realmente fillar como maker)

Use `size=5` (mínimo prático). Não precisa de dezenas de dólares.

## Como rodar

### 1) Dry-run (obrigatório primeiro)

```powershell
cd d:\Projetos\projeto-goldenlens\data-robot
npm run test:fee -- --mode=both
```

Mostra planos e fees esperadas **sem** enviar ordem.

### 2) Taker live (fill quase certo)

```powershell
npm run test:fee -- --mode=taker --live --size=5 --wait=30
```

Confirme na UI: ordem deve executar rápido. No relatório: `trader_side=TAKER` e fee esperada > 0.

### 3) Maker live (pode não fillar)

```powershell
npm run test:fee -- --mode=maker --live --size=5 --wait=120
```

A ordem fica no book (`postOnly`). Só filla se alguém vender na sua bid.

- Se **não fillar** em 120s → cancela (padrão) e tente outro evento / preço mais agressivo.
- Se fillar → `trader_side` deve ser `MAKER` e fee esperada `$0`.

### 4) Comparar os dois (eventos separados ok)

```powershell
npm run test:fee -- --mode=taker --live --size=5
# ... outro evento ...
npm run test:fee -- --mode=maker --live --size=5 --wait=180
```

Compare os JSONs em `runs/fee-*.json`: `trader_side`, `expectedFeeUsd`, `balanceDelta`.

## Como ler o resultado

| Observação | Conclusão |
|------------|-----------|
| Taker `trader_side=TAKER` + fee esperada ≈ Δ saldo | Taxa taker confirmada |
| Maker `trader_side=MAKER` + fee esperada 0 | Hipótese Hopper 3 sustentada |
| Ordem “maker” veio `TAKER` | Preço cruzou o book (não era resting) — refaça com bid mais conservador / postOnly |
| Maker sem fill | Normal; não prova nem desmente — precisa de fill |

**Importante:** o campo `fee_rate_bps` no trade é a taxa do **mercado**, não o valor cobrado em USDC. O papel (`trader_side`) + fórmula + Δ saldo são a evidência.

## Cuidados

- Só rode `--live` com intenção explícita (dinheiro real).
- API key **derivada** (mesma do site) para ver a ordem na UI.
- Maker e taker em **eventos diferentes** é ok — o que importa é o papel no fill.
- Não deixe ordem maker aberta sem querer: o script cancela se não fillar (salvo `--keep-open`).

## Relacionado

- Hopper 3: `polymarket-fm/hopper-3-explicacao.md`
- Fees backtest: `data-backtest/src/backtest/fees.js`
- Validação TFC LEGO: [tfc-validacao-real.md](../tfc-validacao-real.md)
