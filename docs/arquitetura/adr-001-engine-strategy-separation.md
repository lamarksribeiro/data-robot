# ADR-001 — Separação engine / estratégia

- **Status:** Aceito
- **Data:** 2026-07-18
- **Contexto:** P0 do [plano de desenvolvimento](../plano-desenvolvimento.md)

## Decisão

O `data-robot` tem uma **engine genérica** (mercado, feeds, risk, OMS, executor, journal, recovery, control plane) e **plugins de estratégia** que só transformam contexto normalizado em intenções.

O core **não** pode importar uma estratégia concreta. A primeira estratégia de produção será TFC V7 como plugin; Apex Triad e outras entram pelo mesmo contrato.

## Regras

1. Pastas `src/engine/`, `src/oms/`, `src/risk/`, `src/journal/`, `src/executor/`, `src/reconciler/` não importam `src/strategy/*` nem `src/tfc/*`.
2. Estratégias não recebem `ClobClient`, `process.env`, filesystem nem rede.
3. Estratégias devolvem `{ state, intents, diagnostics }` com intents `ENTER | EXIT | REVERSE | CANCEL`.
4. Scripts CLI atuais em `scripts/tfc/` são protótipos de diagnóstico e **não** são a engine; podem importar `src/tfc/` até P6 migrar para o contrato.
5. A verificação automática é `npm run check:architecture`.

## Consequências

- Trocar TFC por Apex (ou outra) não exige segunda engine — só novo plugin + preset + testes de conformidade.
- UI e secrets ficam fora do path quente da estratégia.
- Extensibilidade de dados entra como capability/adapter normalizado, não como `fetch` dentro do plugin.

## Referências

- [Plano §4 Arquitetura-alvo](../plano-desenvolvimento.md)
- [Runbook TFC V7](../tfc-validacao-real.md)
