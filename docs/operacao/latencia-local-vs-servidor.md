# Latência: máquina local (VPN) vs servidor Giovanna

Testes de latência CLOB feitos no PC com VPN **não representam** o ambiente de produção. O robô vai operar no servidor do **Coolify Giovanna** (`coolify.giovannarosito.com`).

Estratégia: medir nos **dois ambientes** com o mesmo script e comparar — o delta vira baseline de melhoria e ajuda a calibrar timeouts da TFC.

> **Atenção:** o script atual envia ordem real sem exigir `--live`. Execute somente com autorização explícita. Antes da próxima campanha, ele deve ser corrigido para exigir confirmação live e cancelar a ordem em `finally` mesmo quando uma etapa intermediária falhar.

## Baseline de 15/07/2026

| Ambiente | Repetições | Ping | Create | Get open | Cancel | Total |
|---|---:|---:|---:|---:|---:|---:|
| Local + VPN | 3 | 284 ms | 586 ms | 568 ms | 572 ms | 1.723 ms |
| Giovanna | 5 | 56 ms | 122 ms | 107 ms | 110 ms | 335 ms |

A mediana do Giovanna atingiu a meta inicial de total <700 ms. A confirmação imediata via `getOpenOrders()` foi inconsistente (2/5 no servidor, 0/3 local), embora todas as ordens tenham sido canceladas. O próximo passo é medir **tempo até visibilidade** com polling e user WebSocket, além de p95/p99; uma única leitura imediata não deve ser tratada como falha definitiva.

## Por que os dois?

| Ambiente | O que mede | Limitação |
|----------|------------|-----------|
| **Local + VPN** | Debugging rápido, credenciais, UI cruzada | RTT extra (VPN), jitter alto |
| **Servidor Giovanna** | Latência real de produção | Precisa `.env` no host/container |

Valores locais tendem a ser **piores** que no servidor. Se a TFC passa localmente com folga, no servidor costuma ser melhor — mas só o teste no servidor define o número oficial.

## F2a — Local (referência, não oficial)

```powershell
cd d:\Projetos\projeto-goldenlens\data-robot
npm run tfc:latency -- --live --label=local --repeat=3 --note="PC + VPN"
```

Salva `runs/latency-local-<timestamp>.json` com hostname, mediana de 3 tentativas, ping `/time`, create/get/cancel.

## F2b — Servidor Giovanna (oficial para produção)

Quando o `data-robot` estiver no Coolify Giovanna (ou via SSH no host):

```bash
cd /caminho/do/data-robot   # ou docker exec no container
export TFC_RUN_LABEL=giovanna
npm run tfc:latency -- --live --label=giovanna --repeat=5 --note="Coolify Giovanna prod"
```

**`.env` no servidor:** copiar manualmente (nunca commitar). Mesmas credenciais derivadas da conta de trading.

### Via `docker exec` (quando app estiver deployada)

```bash
ssh Giovanna
docker ps | grep data-robot
docker exec -it <container> sh -c 'cd /usr/src/app && npm run tfc:latency -- --live --label=giovanna --repeat=5'
```

Baixe o JSON para comparar localmente:

```powershell
scp Giovanna:/caminho/data-robot/runs/latency-giovanna-*.json d:\Projetos\projeto-goldenlens\data-robot\runs\
```

## Comparar resultados

Com os dois arquivos em `runs/`:

```powershell
npm run tfc:latency:compare
npm run tfc:latency:compare -- --labels local,giovanna --json
```

Exemplo de saída:

```
giovanna vs local:
  total:  -120 ms (18.5% mais rápido)
  create: -85 ms
```

## O que registrar

| Métrica | Uso na TFC |
|---------|------------|
| `clobPingMs` | RTT base até Polymarket |
| `create` | Tempo para ordem ir ao book na janela terminal |
| `getOpen` | Poll de confirmação pós-ordem |
| `cancel` | Saída / hedge / late flip |
| `total` | Orçamento de tempo na janela 5–30s |

**Metas provisórias (servidor):**

- `clobPing` p95 < 80 ms
- `create` p95 < 400 ms
- `total` p95 (create+confirmação+cancel) < 700 ms
- 100% das ordens com estado final reconciliado e nenhuma ordem órfã

Metas no local com VPN podem ser 2–3× maiores — não usar para calibrar a estratégia.

## Calibrar timeouts

Use a mediana do **servidor** + margem:

```
timeout_entrada  ≈ create_p95 × 1.5
poll_posição    ≈ getOpen_mediana
cancel_urgente  ≈ cancel_mediana + 100ms
```

Antes do canário, repetir pelo menos `--repeat=30` no servidor em horário de mercado ativo e calcular p50/p95/p99. O script atual reporta mediana e precisa ser ampliado antes de essa medição valer como gate de produção.

## Checklist

- [ ] F2a local com `--label=local --repeat=3`
- [ ] Deploy ou clone `data-robot` no Giovanna
- [ ] `.env` com key derivada no servidor
- [ ] F2b `--label=giovanna --repeat=5`
- [ ] `npm run tfc:latency:compare`
- [ ] Anotar delta e ajustar expectativas da janela terminal

## Relacionado

- [Validação TFC LEGO](../tfc-validacao-real.md) — fase F2
- [Configuração `.env`](../polymarket-configuracao-env.md)
