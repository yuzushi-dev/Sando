#!/usr/bin/env node

import fs from 'node:fs';
import { createLazyMcpGateway } from './src/lazy-mcp-gateway.mjs';
import { publishF4Telemetry, recordF4Event } from './src/f4-telemetry.mjs';
import { createConfiguredMcpServers, startLazyMcpGatewayStdio } from './src/lazy-mcp-gateway-stdio.mjs';

function loadConfig() {
  const source = process.env.SANDO_MCP_GATEWAY_CONFIG;
  if (!source) return { enabled: false, allowlist: [], servers: [] };
  const text = source.trim().startsWith('{') ? source : fs.readFileSync(source, 'utf8');
  return JSON.parse(text);
}

const config = loadConfig();
const output = process.stdout;
const host = process.env.SANDO_F4_HOST || 'unknown';
const f4TelemetryEnabled = process.env.SANDO_F4_TELEMETRY !== '0';
const gateway = createLazyMcpGateway({
  ...config,
  servers: createConfiguredMcpServers(config),
  onMessage: (message) => output.write(`${JSON.stringify(message)}\n`),
  onF4Event: (event) => {
    try {
      const recorded = recordF4Event({ ...event, host, env: process.env });
      if (f4TelemetryEnabled) {
        void publishF4Telemetry(recorded, { endpoint: process.env.SANDO_F4_TELEMETRY_ENDPOINT }).catch(() => {});
      }
    }
    catch { /* local tracing must never affect the MCP gateway */ }
  },
});
startLazyMcpGatewayStdio({ gateway, output });
