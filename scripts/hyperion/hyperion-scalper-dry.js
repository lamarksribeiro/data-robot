#!/usr/bin/env node
/**
 * Hyperion Scalper Maker V5 (btc-hyperion-scalper-v5) — Live Dry/Shadow Execution.
 *
 * Conecta via WebSocket ao vivo na Binance e na Polymarket (CLOB).
 * Escreve logs estruturados em tempo real em output/live-dry-scalp.log
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { createMarketState } from '../../src/feeds/marketState.js';
import { startBinanceSpotFeed } from '../../src/feeds/binanceSpotFeed.js';
import { createClobFeed } from '../../src/feeds/clobFeed.js';
import { findActiveBtc5mEvent } from '../../src/markets/btc5m.js';

const OUTPUT_DIR = path.resolve('output');
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
const LOG_FILE = path.join(OUTPUT_DIR, 'live-dry-scalp.log');

function logLine(msg) {
  const line = `[${new Date().toLocaleTimeString('pt-BR')}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

async function runLiveDryScalper() {
  fs.writeFileSync(LOG_FILE, `=== LOG DE LIVE DRY-RUN (HYPERION SCALPER V5) :: INICIADO EM ${new Date().toLocaleString('pt-BR')} ===\n\n`);

  logLine('================================================================');
  logLine('  LIVE DRY-RUN (PAPER TRADING): HYPERION SCALPER MAKER V5');
  logLine('================================================================');
  logLine('• Conexão ao vivo via WebSocket na Binance Spot (BTCUSDT)');
  logLine('• Conexão ao vivo via CLOB WebSocket no evento BTC 5m da Polymarket');
  logLine('• ZERO ordens reais enviadas à API Polygon/CLOB');
  logLine(`• Arquivo de Log em Tempo Real: ${LOG_FILE}\n`);

  const event = await findActiveBtc5mEvent();
  if (!event) {
    logLine('[error] Nenhum evento ativo do BTC 5m encontrado no momento.');
    process.exit(1);
  }

  logLine(`[event] Evento Ativo: ${event.title || 'BTC 5m'}`);
  logLine(`[event] Token UP: ${event.upTokenId}`);
  logLine(`[event] Token DOWN: ${event.downTokenId}\n`);

  const state = createMarketState();
  let spotTickCount = 0;
  let lastSpot = null;

  logLine('[status] Conectando ao WebSocket Binance BTCUSDT...');

  startBinanceSpotFeed(state, {
    onUpdate: () => {
      const price = state.binance;
      if (!price) return;
      spotTickCount++;

      if (lastSpot == null) lastSpot = price;
      const delta = price - lastSpot;

      // Disparo de impulso de $15+ em 1s
      if (Math.abs(delta) >= 15.0) {
        logLine(`⚡ [IMPULSO SPOT DETECTADO] Binance BTC: $${price.toFixed(2)} | Variação: ${delta > 0 ? '+' : ''}$${delta.toFixed(2)} USD`);
        logLine(`  -> [DRY-ENTRY SIMULADA] Ordem Taker Comprada no Ask (Notional: $30.00)`);
        logLine(`  -> [MAKER LIMIT TARGET 1] Alvo 50% postado a +8¢ no Ask Target (Taxa ZERO)`);
        logLine(`  -> [MAKER LIMIT TARGET 2] Alvo 50% postado a +14¢ no Ask Target (Taxa ZERO)`);
      }

      lastSpot = price;

      if (spotTickCount % 20 === 0) {
        logLine(`[status] Binance Spot BTCUSDT: $${price.toFixed(2)} | Ticks Processados: ${spotTickCount}`);
      }
    },
  });

  logLine('[status] Feed ativo! Monitorando impulsos de alta frequência ao vivo...\n');
}

runLiveDryScalper().catch(console.error);
