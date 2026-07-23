#!/usr/bin/env node

import 'dotenv/config';
import { createUiServer } from '../src/ui/server.js';

const app = createUiServer({
  host: process.env.HOST || '0.0.0.0',
  port: Number(process.env.PORT || 3200),
  engineBaseUrl: process.env.ENGINE_INTERNAL_URL || 'http://127.0.0.1:3201',
  engineOpsToken: process.env.ENGINE_OPS_TOKEN,
  dashboardUser: process.env.DASHBOARD_USER,
  dashboardPassword: process.env.DASHBOARD_PASSWORD,
  secureCookie: process.env.NODE_ENV === 'production',
});

await app.start();
console.log(`[ui] dashboard listen ${app.host}:${app.server.address().port}`);

async function shutdown(signal) {
  console.log(`[ui] ${signal} — shutdown`);
  await app.stop();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

