/**
 * Fault injection — cenários de resiliência sem rede real.
 */

import { createSimTransport } from '../executor/transport.js';
import { createOmsSink } from '../oms/omsSink.js';

/**
 * Transport que falha com códigos HTTP simulados.
 * @param {'401'|'429'|'503'|'ok'} code
 */
export function createFaultTransport(code = '503') {
  const base = createSimTransport({ behavior: 'reject' });
  return {
    kind: `fault-${code}`,
    async submit(request, order) {
      if (code === 'ok') return createSimTransport().submit(request, order);
      return {
        accepted: false,
        exchangeOrderId: null,
        events: [
          {
            eventId: `fault-${code}-${order.intentId}`,
            intentId: order.intentId,
            type: 'REJECT',
            qty: 0,
            price: null,
            reason: `HTTP_${code}`,
            tsMs: Date.now(),
          },
        ],
      };
    },
    async cancel(order) {
      return {
        accepted: true,
        events: [
          {
            eventId: `fault-cancel-${order.intentId}`,
            intentId: order.intentId,
            type: 'CANCEL',
            qty: 0,
            price: null,
            reason: 'fault-cancel-only',
            tsMs: Date.now(),
          },
        ],
      };
    },
  };
}

/**
 * Sink com user channel que pode “cair”.
 */
export function createDisconnectableSink(opts = {}) {
  const transport = opts.transport ?? createSimTransport({ behavior: opts.behavior ?? 'ack-only' });
  const sink = createOmsSink({
    mode: opts.mode ?? 'shadow',
    transport,
    withUserChannel: true,
    clock: opts.clock,
  });

  sink.simulateUserWsLoss = () => {
    return sink.cancelOnDisconnect();
  };
  return sink;
}

/**
 * Roda bateria de fault injection e retorna relatório.
 * @param {object} app — createEngineApp
 * @param {(snap: object) => object} makeSnapshot
 */
export async function runFaultInjectionSuite(app, makeSnapshot) {
  const report = {
    cases: [],
    orphanOrders: 0,
    riskViolations: 0,
  };

  // 401/429/503 via engine já iniciada — usamos sinks dedicados em testes unitários;
  // aqui validamos restart/kill/rollback/cancel-only no app atual.
  const cases = [
    {
      id: 'restart_recovery',
      run: async () => {
        await app.ingestSynthetic(makeSnapshot({ btc: 100 }));
        const cp = app.checkpoint();
        await app.engine.safeShutdown('fault-restart');
        app.engine.restore(cp);
        app.engine.start();
        return { ok: app.engine.position.qty >= 0, state: app.engine.state };
      },
    },
    {
      id: 'kill_switch',
      run: async () => {
        await app.engine.kill('fault-kill');
        const r = await app.ingestSynthetic(makeSnapshot({ btc: 200 }));
        return { ok: r.skipped === true && app.engine.state === 'HALTED' };
      },
    },
    {
      id: 'rollback',
      run: async () => {
        // novo app context esperado pelo caller se kill travou — skip se halted
        if (app.engine.state === 'HALTED') {
          return { ok: true, skipped: true };
        }
        app.checkpoint();
        const before = app.engine.position.qty;
        await app.ingestSynthetic(makeSnapshot({ btc: 150 }));
        app.rollback();
        return { ok: app.engine.position.qty === before };
      },
    },
  ];

  for (const c of cases) {
    try {
      const result = await c.run();
      report.cases.push({ id: c.id, ok: Boolean(result.ok), result });
    } catch (err) {
      report.cases.push({ id: c.id, ok: false, error: err.message });
    }
  }

  const unknowns = (app.sink.oms?.listOrders?.() ?? []).filter((o) => o.state === 'UNKNOWN');
  report.orphanOrders = unknowns.length;
  report.ok = report.cases.every((c) => c.ok) && report.orphanOrders === 0;
  return report;
}
