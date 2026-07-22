# ADR-001 — Separação engine / estratégia

- **Status:** Aceito
- **Data:** 2026-07-18
- **Contexto:** P0 do [plano de desenvolvimento](../plano-desenvolvimento.md)

## Decisão

O `data-robot` tem uma **engine genérica** (mercado, feeds, risk, OMS, executor, journal, recovery, control plane) e **plugins de estratégia** que só transformam contexto normalizado em intenções.

O core **não** pode importar uma estratégia concreta. TFC V7, MIDAS Carry V1, Apex Triad e futuras estratégias entram pelo mesmo contrato. A escolha de uma candidata para promoção live é decisão de produto, não dependência arquitetural da engine.

## Regras

1. Pastas `src/engine/`, `src/oms/`, `src/risk/`, `src/journal/`, `src/executor/`, `src/reconciler/` não importam `src/strategy/*` nem `src/tfc/*`.
2. Estratégias não recebem `ClobClient`, `process.env`, filesystem nem rede.
3. Estratégias devolvem `{ state, intents, diagnostics }` com intents `ENTER | EXIT | REVERSE | CANCEL`.
4. Scripts CLI atuais em `scripts/tfc/` são protótipos de diagnóstico e **não** são a engine; podem importar `src/tfc/` até P6 migrar para o contrato.
5. A verificação automática é `npm run check:architecture`.
6. Plugins concretos são registrados por allowlist explícita no composition root; estar no catálogo não autoriza execução live.

## Consequências

- Trocar ou disponibilizar TFC, MIDAS, Apex ou outra não exige outra implementação de engine — só plugin, preset, conformidade e gates próprios.
- UI e secrets ficam fora do path quente da estratégia.
- Extensibilidade de dados entra como capability/adapter normalizado, não como `fetch` dentro do plugin.
- Engine Ready é aprovado com fixtures e não depende da estratégia escolhida para canário.
- Disponibilidade, ativação e concorrência de plugins seguem o [ADR-002](./adr-002-strategy-catalog-supervision.md).

## Referências

- [Plano §4 Arquitetura-alvo](../plano-desenvolvimento.md)
- [ADR-002 — Catálogo e supervisão](./adr-002-strategy-catalog-supervision.md)
- [Runbook TFC V7](../tfc-validacao-real.md)
