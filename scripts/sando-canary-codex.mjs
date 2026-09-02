#!/usr/bin/env node

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
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

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
}

function canaryHomes(hooksConfig) {
  const stateHome = path.join(os.homedir(), '.local', 'state', 'sando', 'canary');
  const home = path.join(stateHome, 'codex-home');
  const codexHome = path.join(home, '.codex');
  ensurePrivateDirectory(stateHome);
  ensurePrivateDirectory(home);
  ensurePrivateDirectory(codexHome);
  const source = path.join(os.homedir(), '.codex', 'auth.json');
  const target = path.join(codexHome, 'auth.json');
  if (!fs.existsSync(source)) throw new Error('Codex auth.json is missing; authenticate the normal Codex client first');
  const targetStat = fs.lstatSync(target, { throwIfNoEntry: false });
  if (!targetStat) fs.symlinkSync(source, target);
  else if (!targetStat.isSymbolicLink() || fs.realpathSync(target) !== fs.realpathSync(source)) {
    throw new Error('isolated Codex auth path already exists and is not the normal auth.json link');
  }
  const hooksTarget = path.join(codexHome, 'hooks.json');
  const hooksStat = fs.lstatSync(hooksTarget, { throwIfNoEntry: false });
  if (!hooksStat) fs.symlinkSync(hooksConfig, hooksTarget);
  else if (!hooksStat.isSymbolicLink()) {
    throw new Error('isolated Codex hooks path already exists and is not the canary hooks link');
  } else {
    let currentHooksPath;
    try { currentHooksPath = fs.realpathSync(hooksTarget); } catch { fs.unlinkSync(hooksTarget); }
    if (!currentHooksPath) fs.symlinkSync(hooksConfig, hooksTarget);
    if (fs.realpathSync(hooksTarget) !== fs.realpathSync(hooksConfig)) {
      throw new Error('isolated Codex hooks path already exists and is not the canary hooks link');
    }
  }
  return { home, codexHome, stateHome };
}

function codexBinary() {
  if (process.env.SANDO_CODEX_BIN) return process.env.SANDO_CODEX_BIN;
  const installed = path.join(os.homedir(), '.codex', 'packages', 'standalone', 'current', 'bin', 'codex');
  if (fs.existsSync(installed)) return installed;
  const command = execFileSync('sh', ['-lc', 'command -v codex'], { encoding: 'utf8' }).trim();
  const launcher = fs.readFileSync(command, 'utf8');
  const match = launcher.match(/--executable\s+(\S+)/);
  return match ? match[1] : command;
}

function tomlString(value) { return JSON.stringify(value); }

function mcpOverride(stateHome) {
  const eventsPath = process.env.SANDO_F4_EVENTS_PATH || path.join(stateHome, 'f4-events.jsonl');
  return `mcp_servers.sando-f4-canary={transport="stdio",command=${tomlString(process.execPath)},args=[${tomlString(path.join(root, 'packages', 'sando', 'gateway.mjs'))}],env={SANDO_MCP_GATEWAY_CONFIG=${tomlString(JSON.stringify(gatewayConfig))},SANDO_F4_HOST="codex",SANDO_F4_EVENTS_PATH=${tomlString(eventsPath)},SANDO_F4_TELEMETRY="0"}}`;
}

function validateConfig() {
  const config = gatewayConfig;
  if (config.enabled !== true || JSON.stringify(config.allowlist) !== JSON.stringify(['sando-local-readonly'])
    || config.servers?.length !== 1 || config.servers[0]?.name !== 'sando-local-readonly') {
    throw new Error('F4 canary configuration must be enabled with the single read-only allowlist');
  }
}

function hookCommand(name) {
  const pluginRoot = path.join(root, 'plugins', 'sando');
  return `PLUGIN_ROOT=${JSON.stringify(pluginRoot)} ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(pluginRoot, 'hooks', name))}`;
}

function createHooksConfig() {
  const stateHome = path.join(os.homedir(), '.local', 'state', 'sando', 'canary');
  ensurePrivateDirectory(stateHome);
  const filePath = path.join(stateHome, 'codex-hooks.json');
  const hooks = {
    SessionStart: [{ hooks: [{ type: 'command', command: hookCommand('session-start.mjs'), timeout: 5 }] }],
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: hookCommand('user-prompt-submit.mjs'), timeout: 1 }] }],
    PreToolUse: [{ matcher: '^(Bash|exec_command|shell_command)$', hooks: [{ type: 'command', command: hookCommand('pre-tool-use.mjs'), timeout: 5 }] }],
    PostToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: hookCommand('post-tool-use.mjs'), timeout: 5 }] }],
    Stop: [{ matcher: '.*', hooks: [{ type: 'command', command: hookCommand('provider-usage.mjs'), timeout: 5 }] }],
  };
  const temporary = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify({ hooks }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, filePath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return { filePath };
}

export function modelArguments(forwarded = process.argv.slice(2), env = process.env) {
  const configured = env.SANDO_CODEX_MODEL?.trim();
  if (forwarded.includes('--model') || forwarded.includes('-m') || !configured) return [];
  return ['--model', configured];
}

function main() {
  validateConfig();
  const config = createHooksConfig();
  const homes = canaryHomes(config.filePath);
  const forwarded = process.argv.slice(2);
  const modelDefaults = modelArguments(forwarded);
  const child = spawn(codexBinary(), [
    '--dangerously-bypass-hook-trust', ...modelDefaults, '-c', 'model_reasoning_effort="medium"', '-c', mcpOverride(homes.stateHome), ...forwarded,
  ], {
    cwd: root,
    env: {
      ...process.env,
      HOME: homes.home,
      CODEX_HOME: homes.codexHome,
      SANDO_EXPERIMENT_ARM: process.env.SANDO_EXPERIMENT_ARM || 'apply',
      SANDO_EXPERIMENT: process.env.SANDO_EXPERIMENT || 'personal-canary',
      SANDO_PROVIDER_USAGE_PATH: process.env.SANDO_PROVIDER_USAGE_PATH || path.join(homes.stateHome, 'provider-usage.json'),
      SANDO_METRICS_PATH: process.env.SANDO_METRICS_PATH || path.join(homes.stateHome, 'metrics.json'),
    },
    stdio: 'inherit',
  });
  child.on('error', (error) => { process.stderr.write(`sando canary Codex: ${error.message}\n`); process.exitCode = 2; });
  child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { main(); }
  catch (error) {
    process.stderr.write(`sando canary Codex: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
