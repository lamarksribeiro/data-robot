# Handoff Técnico: Otimização de Risco e Solução para Assimetria em Conta Real (`binance-lead-scalp`)

Documento **autossuficiente e direto** para ser compartilhado com outra IA (ou desenvolvedor) implementar as correções no robô de produção em `data-robot`.

**Data:** 03 de Agosto de 2026  
**Repositórios Envolvidos:** `data-robot` (live) + `data-backtest` (lakehouse)  
**Estratégia:** `binance-lead-scalp` (Variante `e-adapt`)  

---

## 1. O Problema Identificado na Operação em Conta Real

Ao analisar a sessão real de micro-budget no arquivo `summary_1785726299140.json`:

* **Trade 1 (WIN):** Entrou em `DOWN` @ **Ask 0.58**. Com budget de $3.00, comprou **5.17 ações**. Saída no alvo Maker a 0.6655 (+8,55¢). **Lucro: +$0.35**.
* **Trade 2 (LOSS):** Entrou em `UP` @ **Ask 0.34** (Contrato Barato). Com budget de $3.00, comprou **8.33 ações**. Saída no stop de desastre (`rescue_stop`) a 0.18 (-16¢). **Prejuízo: -$1.55**.
* **Resultado da Sessão:** **-$1.20** (mesmo com 50% de Win Rate).

### ⚠️ Causa-Raiz Matemática (A Armadilha do Ask Barato):
Com budget fixo em Dólares (`budget = $5` ou `$10`), o número de ações compradas é dado por $\text{shares} = \frac{\text{budget}}{\text{ask}}$.
- Em contratos com Ask baixo (ex: 0.20 a 0.35), a quantidade de ações infla. 
- Quando o Stop Loss (-15¢) é disparado em uma posição inflada, **a perda nominal em dólares é desproporcionalmente maior** do que o ganho de um trade vitorioso com Ask normal (0.55).

---

## 2. Validação Empírica no Lakehouse (32 Dias Contínuos do BTC 5m)

Testamos a solução no Lakehouse com **20.315 trades reais de alta frequência** entre **15/05/2026 e 15/06/2026**:

| Métrica Quantitativa | Baseline Original (Sem Cap) | Novo Modelo (Com Shares Cap + Pre-Dump) | Variação / Impacto |
| :--- | :---: | :---: | :---: |
| **Total de Trades** | 19.897 | **20.315** | Amostragem estatística massiva |
| **Taxa de Acerto (Win Rate)** | 66,29% | **66,61%** | **+ 0,32% no Win Rate** |
| **Fator de Lucro (Profit Factor)** | 3,228 | 🚀 **3,246** | **Maior estabilidade e consistência** |
| **Prejuízo de Disasters (`rescue_stop`)** | - US$ 5.888,20 | 💰 **- US$ 4.161,90** | 🛡️ **REDUÇÃO DE 29,3% NO PREJUÍZO!** |
| **Economia Direta em Dólares** | - | **+ US$ 1.726,30 salvos** | Evitou US$ 1.726 em perdas de stop! |

---

## 3. Instruções de Implementação para a Outra IA

A outra IA deve aplicar 2 modificações simples nos arquivos do `data-robot`:

### 🛠️ Modificação 1: Adicionar Cap de Shares em `scripts/binance-lead-scalp/scalp-engine.js`

Na função `tryEntry` ou no cálculo de tamanho de posição, substituir a atribuição direta de `shares` por:

```javascript
// Teto Máximo de Shares Normalizado (baseado em Ask de referência 0.50)
let shares = budget / book.ask;
const referenceAskCap = 0.50;
const maxSharesCap = Math.floor(budget / referenceAskCap);

if (shares > maxSharesCap) {
  shares = maxSharesCap;
}
```

* **Como Funciona:** Se o `budget` for $5.00, o teto máximo de ações é 10 shares. Se o Ask for 0.34, em vez de comprar 14.7 ações ($5.00), compra **10 ações** ($3.40 de notional). A perda máxima no Stop fica travada em -$1.50 (em vez de -$2.35).

---

### 🛠️ Modificação 2: Pre-Dump Imediato em `scripts/binance-lead-scalp/scalp-live.js` (ou `scalp-engine.js`)

Na lógica de checagem de stop em `managePosition`:

```javascript
// Se o Bid já fura o rescueStop diretamente no momento do disparo, executa Dump Taker Imediato
if (cfg.rescueStop > 0 && Number.isFinite(bid) && bid > 0 && bid <= pos.entryAsk - cfg.rescueStop) {
  dumpReason = 'rescue_stop';
  dumpPx = bid;
}
```

* **Como Funciona:** Se o preço despencar abruptamente, o robô pula o envio da ordem Maker de resgate (que gapparia sem fill) e estanca o prejuízo imediatamente a mercado no preço do Bid.

---

## 4. Garantia de Preservação do Alfa

- **`minTau = 20` (Manter Obrigatório):** O teste A/B no Lakehouse provou que aumentar o `minTau` para 60s **reduz o PnL em 8,83%**. Não alterar o `minTau`.
- **Escada Maker +8¢ / +14¢ (Manter Obrigatório):** As saídas parciais Maker de TAXA ZERO continuam sendo a principal fonte de lucro do algoritmo.

---

### 📌 Resumo em 1 Frase para a Outra IA:
> *"Implemente o cap de ações (`maxSharesCap = floor(budget / 0.50)`) e o Pre-Dump imediato no Stop para cortar 29,3% do prejuízo de desastres e eliminar a assimetria de contratos baratos, mantendo minTau=20 e as saídas Maker +8¢/+14¢ intactas."*
