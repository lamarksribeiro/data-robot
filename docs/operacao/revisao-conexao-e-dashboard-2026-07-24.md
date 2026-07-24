# Revisão — Conexão do Engine e Dashboard/UI (2026-07-24)

Análise técnica da camada de conexão do engine (estabilidade, segurança, velocidade) e da interface de uso (dashboard, control plane, autenticação). Objetivo: identificar melhorias concretas antes da campanha shadow supervisionada.

Status: achados a revisar, nenhuma ação aplicada ainda.

## Metodologia

Leitura direta de código-fonte (`src/net`, `src/clob`, `src/feeds`, `src/executor`, `src/engine`, `src/control`, `src/ui`, `public/js`), documentação existente (`docs/arquitetura/observability-p5.md`, `docs/operacao/deploy-giovanna.md`) e execução da suíte `npm run p9:readiness` (9/9 testes passando).

---

## 1. Conexão do engine

### 1.1 Segurança

| Severidade | Achado | Local | Correção proposta |
|---|---|---|---|
| Crítico | Monkey-patch global de `fetch` em `applySocksExit()` redireciona todo tráfego HTTP via túnel SOCKS/SSH (Giovanna) usando axios. Módulos que capturam referência ao `fetch` nativo antes do patch continuam indo direto para a internet — split-brain onde parte do tráfego (potencialmente ordens) pode vazar fora do túnel, arriscando exposição de IP/identidade num setup pensado para IP fixo. Também ignora `AbortSignal` passado pelo chamador, então timeouts locais (ex.: 4s em `clobFeed.js:140`) podem não ser respeitados. | `src/net/applySocksExit.js:18-37` | Garantir que o patch seja aplicado antes de qualquer import que use `fetch`; propagar `AbortSignal` para o axios (`signal: init.signal`); adicionar verificação de que o proxy está ativo antes de enviar requisições sensíveis. |
| Importante | Chave privada e credenciais L2 (api key/secret/passphrase) trafegam em memória sem redaction centralizada. Um `console.log`/dump de erro do axios (que inclui `config.headers`) pode vazar segredos nos logs. | `src/clob/buildClient.js:7-20`, `src/clob/wallet.js:10` | Criar wrapper de logger com redaction automática para padrões de chave/segredo; aplicar em todos os pontos de log de erro. |
| Menor (boa prática já aplicada) | `scripts/test-connection.js` loga apenas o prefixo da API key. | `scripts/test-connection.js:60` | Padronizar esse cuidado em todos os pontos que logam credenciais. |

### 1.2 Estabilidade

| Severidade | Achado | Local | Correção proposta |
|---|---|---|---|
| Importante | `submit`, `cancel`, `reconcile` e `cancelAll` não têm timeout nem retry explícitos; dependem do timeout default do SDK/axios. Falha de rede em `reconcile`/`cancelAll` pode travar o loop do engine indefinidamente. | `src/executor/liveTransport.js:106-118` (submit), `:212` (cancel), `:257` (reconcile), `:346` (cancelAll) | Adicionar timeout explícito (`AbortSignal.timeout`) e retry com backoff para operações idempotentes (reconcile, cancelAll); para `submit`, manter sem retry automático (evita duplicidade de ordens) mas com timeout curto e falha explícita. |
| Importante | Timeout de 60s configurado para todo tráfego roteado pelo proxy — excessivo para um engine que opera em janelas de 5 minutos; pode travar `await` no caminho crítico. | `src/net/applySocksExit.js:36` | Reduzir para um valor compatível com o SLA de 5 min (ex.: 5-10s) e propagar `AbortSignal` do chamador. |
| Positivo — nenhuma ação necessária | `rtdsFeed.js`, `clobFeed.js` e `userChannel.js` implementam reconexão com backoff exponencial + jitter (`RECONNECT_BASE_MS=400`, cap 8s), watchdog de staleness e proteção anti-churn (mín. 5s entre force-reconnects). | `src/feeds/rtdsFeed.js`, `src/feeds/clobFeed.js`, `src/executor/userChannel.js` | — |
| Menor | Sem circuit breaker: se a API CLOB rejeitar sistematicamente (ex. 429), o engine continua tentando submeter ordens a cada ciclo sem cooldown adaptativo. | `src/executor/liveTransport.js` | Adicionar contador de falhas consecutivas com pausa temporária adaptativa. |

### 1.3 Velocidade

| Severidade | Achado | Local | Correção proposta |
|---|---|---|---|
| Importante | Todo tráfego HTTP (incluindo submissão de ordens) passa por túnel SOCKS via SSH para "Giovanna", adicionando RTT extra fixa ao caminho crítico. Não há medição contínua comparando latência com/sem proxy em produção. | `src/net/applySocksExit.js` | Rodar `scripts/tfc/measure-order-latency.js` nos dois modos (com/sem proxy) e documentar o custo real; considerar se o ganho de IP fixo compensa a latência adicionada. |
| Menor | Sem HTTP keep-alive/agent pooling configurado explicitamente para o `ClobClient` — cada requisição pode reabrir handshake TLS. | Cliente CLOB (via SDK, sem `applySocksExit`) | Configurar `httpsAgent: new https.Agent({ keepAlive: true })` no client CLOB. |
| Menor | Polling REST de reseed (`RESEED_MS=5000`, `STALE_RESEED_MS=8000`) roda como fallback ao WS mesmo quando o WS está saudável, duplicando carga. | `src/feeds/clobFeed.js` | Checar `state.wsClobConnected` antes de disparar reseed por staleness. |

### 1.4 Ações prioritárias — conexão

1. Revisar o monkey-patch global de fetch: evitar split-brain de proxy, propagar `AbortSignal`, reduzir timeout de 60s.
2. Adicionar redaction de segredos em todos os pontos de logging.
3. Adicionar timeout explícito + retry/circuit breaker em `liveTransport.js` (reconcile/cancelAll).
4. Medir e documentar o custo real de latência do túnel SOCKS vs. conexão direta.

---

## 2. Dashboard e interface de uso

Testes automatizados (`npm run p9:readiness`) passaram 9/9 (dashboard autenticado, ciclo operacional, rotação com posição live, late-flip). Nenhum bug funcional crítico encontrado. Polling do dashboard (`setInterval(refresh, 5000)`) é limpo corretamente em login/logout, sem leak de timers; `actionRunning` desabilita corretamente os botões de controle durante execução.

### 2.1 Segurança

| Severidade | Achado | Local | Correção proposta |
|---|---|---|---|
| Importante | Endpoints GET da engine (`/status`, `/metrics`, `/audit`, `/strategy-library`, `/catalog`, `/instances`) não exigem `x-ops-token` — só as rotas `POST /control/*` chamam `authorize(req)`. Em produção `Dockerfile.engine` seta `ENGINE_HOST=0.0.0.0`, então qualquer processo com acesso à rede interna do Coolify lê auditoria completa, métricas e biblioteca de estratégias sem autenticação. | `src/control/httpServer.js:72-111` | Aplicar `authorize(req)` também nas rotas GET, ao menos nas sensíveis (`/audit`, `/strategy-library`). |
| Menor | Rate limit de login é um `Map` em memória por IP — reseta a cada restart do container (comum em Coolify) e não persiste entre réplicas. Aceitável para operador único atual. | `src/ui/server.js:57,152-166` | Sem ação imediata; revisar se o dashboard ganhar múltiplos operadores/réplicas. |
| Positivo — nenhuma ação necessária | Autenticação sólida: cookie `HttpOnly; SameSite=Strict; Secure`, comparação `timingSafeEqual`, CSRF via checagem de `Origin` nas mutações, CSP restritiva em `serveStatic`, confirmação textual obrigatória (`CONFIRMATION_REQUIRED`) em três camadas (UI, proxy, engine) para ações destrutivas (kill, cancel-all, rollback). | `src/ui/server.js:120-127` e outros | — |

### 2.2 Funcional

Nenhum bug funcional crítico encontrado nesta revisão.

### 2.3 UX / Consistência

| Severidade | Achado | Local | Observação |
|---|---|---|---|
| Informativo — sem dívida técnica real | Catálogo MIDAS/APEX Triad consistente: a UI renderiza dinamicamente a partir do catálogo (`renderCatalog`, `resolvePresetPresentation`), não de listas hardcoded. O commit que adicionou APEX (`af0f165`) já atualizou `public/index.html`. O mapa `MIDAS_PRESET_UI` é apenas fallback documentado para cache antigo sem `displayTitle`. | `public/js/dashboard.js` | Nenhuma ação necessária. |

### 2.4 Ações prioritárias — dashboard

1. Fechar o gap de autorização nos endpoints GET do control plane, priorizando `/audit` e `/strategy-library`.
2. Sem urgência: revisitar rate-limit de login se o número de operadores/réplicas crescer.

---

## Resumo executivo — ordem sugerida de execução

1. **Autorização nos endpoints GET do control plane** (baixo esforço, baixo risco, fecha exposição desnecessária de auditoria/métricas).
2. **Monkey-patch de fetch/timeout no proxy SOCKS** (maior risco de segurança e estabilidade — split-brain de tráfego e timeout de 60s no caminho crítico).
3. **Timeout + retry/circuit breaker em `liveTransport.js`** para reconcile/cancelAll.
4. **Medição de latência com/sem túnel SOCKS** para decidir se vale manter o roteamento fixo via Giovanna.
5. Redaction de segredos em logs (transversal, aplicar junto com os itens acima).
