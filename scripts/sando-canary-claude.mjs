#!/usr/bin/env node

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const stateHome = path.join(os.homedir(), '.local', 'state', 'sando', 'canary');
const gatewayScript = path.join(root, 'packages', 'sando', 'gateway.mjs');
const gatewayConfig = {
  enabled: true,
  allowlist: ['sando-local-readonly'],
  servers: [{
    name: 'sando-local-readonly',
    command: process.execPath,
    args: [path.join(root, 'adapters', 'claude', 'sando', 'mcp', 'server.mjs')],
    cwd: root,
    capabilities: ['read-only', 'local'],
  }],
};

function ensureStateHome() {
  fs.mkdirSync(stateHome, { recursive: true, mode: 0o700 });
  fs.chmodSync(stateHome, 0o700);
}

function validateConfig() {
  const config = gatewayConfig;
  if (config.enabled !== true || JSON.stringify(config.allowlist) !== JSON.stringify(['sando-local-readonly'])
    || config.servers?.length !== 1 || config.servers[0]?.name !== 'sando-local-readonly') {
    throw new Error('F4 canary configuration must be enabled with the single read-only allowlist');
  }
}

function writePrivateJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  fs.chmodSync(filePath, 0o600);
}

function createMcpConfig() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-claude-canary-'));
  const filePath = path.join(directory, 'mcp.json');
  writePrivateJson(filePath, {
    mcpServers: {
      'sando-f4-canary': {
        type: 'stdio',
        command: process.execPath,
        args: [gatewayScript],
        env: {
          SANDO_MCP_GATEWAY_CONFIG: JSON.stringify(gatewayConfig),
          SANDO_F4_HOST: 'claude',
          SANDO_F4_EVENTS_PATH: process.env.SANDO_F4_EVENTS_PATH || path.join(stateHome, 'f4-events.jsonl'),
          SANDO_F4_TELEMETRY: process.env.SANDO_F4_TELEMETRY || '0',
        },
      },
    },
  });
  return { directory, filePath };
}

function main() {
  validateConfig();
  ensureStateHome();
  const config = createMcpConfig();
  const child = spawn(process.env.SANDO_CLAUDE_BIN || 'claude', [
    '--strict-mcp-config', '--mcp-config', config.filePath,
    '--plugin-dir', path.join(root, 'adapters', 'claude', 'sando'),
    ...process.argv.slice(2),
  ], {
    cwd: root,
    env: {
      ...process.env,
      SANDO_EXPERIMENT_ARM: process.env.SANDO_EXPERIMENT_ARM || 'apply',
      SANDO_EXPERIMENT: process.env.SANDO_EXPERIMENT || 'personal-canary',
      SANDO_PROVIDER_USAGE_PATH: process.env.SANDO_PROVIDER_USAGE_PATH || path.join(stateHome, 'provider-usage.json'),
      SANDO_METRICS_PATH: process.env.SANDO_METRICS_PATH || path.join(stateHome, 'metrics.json'),
      SANDO_F4_HOST: process.env.SANDO_F4_HOST || 'claude',
      SANDO_F4_EVENTS_PATH: process.env.SANDO_F4_EVENTS_PATH || path.join(stateHome, 'f4-events.jsonl'),
      SANDO_F4_TELEMETRY: process.env.SANDO_F4_TELEMETRY || '0',
    },
    stdio: 'inherit',
  });
  child.on('error', (error) => {
    fs.rmSync(config.directory, { recursive: true, force: true });
    process.stderr.write(`sando canary Claude: ${error.message}\n`);
    process.exitCode = 2;
  });
  child.on('exit', (code, signal) => {
    fs.rmSync(config.directory, { recursive: true, force: true });
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}

try { main(); }
catch (error) {
  process.stderr.write(`sando canary Claude: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
