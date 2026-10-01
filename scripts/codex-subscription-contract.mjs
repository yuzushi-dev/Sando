#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  hookWrapperSource, hooksConfig, privateDirectory, resolveExecutable, startAppServer, trustHooks,
} from './codex-loopback-contract.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
const sourceAuth = '/home/gumi/.codex/auth.json';

function environment(root, codexPath) {
  const env = {
    PATH: `${path.dirname(codexPath)}:/usr/bin:/bin`,
    HOME: path.join(root, 'home'),
    CODEX_HOME: path.join(root, 'codex-home'),
    XDG_CONFIG_HOME: path.join(root, 'xdg-config'),
    XDG_CACHE_HOME: path.join(root, 'xdg-cache'),
    XDG_DATA_HOME: path.join(root, 'xdg-data'),
    XDG_STATE_HOME: path.join(root, 'xdg-state'),
    DO_NOT_TRACK: '1',
    SANDO_CLI_ROUTING: '1',
    SANDO_SHELL_WRAP: '1',
  };
  for (const key of ['HOME', 'CODEX_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME']) privateDirectory(env[key]);
  return env;
}

function parseJsonLines(text) {
  return text.split('\n').flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

function authCredentialValues(auth) {
  const values = [];
  const visit = (value) => {
    if (typeof value === 'string' && value) values.push(value);
    else if (value && typeof value === 'object') Object.values(value).forEach(visit);
  };
  visit(auth?.tokens);
  if (typeof auth?.OPENAI_API_KEY === 'string' && auth.OPENAI_API_KEY) values.push(auth.OPENAI_API_KEY);
  return [...new Set(values)];
}

function authError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function hasSubscriptionAuthShape(auth) {
  return auth?.auth_mode === 'chatgpt' && auth.tokens && typeof auth.tokens === 'object'
    && !Array.isArray(auth.tokens);
}

function boundedSetup(promise, timeoutMs, signal) {
  if (timeoutMs === null && !signal) return promise;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const error = new Error('subscription setup interrupted');
      error.code = 'SUBSCRIPTION_SETUP_INTERRUPTED';
      reject(error);
      return;
    }
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      callback(value);
    };
    const setupError = (message, code) => {
      const error = new Error(message);
      error.code = code;
      return error;
    };
    const onAbort = () => finish(reject, setupError('subscription setup interrupted', 'SUBSCRIPTION_SETUP_INTERRUPTED'));
    const timer = timeoutMs === null ? null : setTimeout(() => (
      finish(reject, setupError('subscription setup timeout', 'SUBSCRIPTION_SETUP_TIMEOUT'))
    ), timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then((value) => finish(resolve, value), (error) => finish(reject, error));
  });
}

export async function prepareSubscriptionEnvironment({
  workspace, arm = 'apply', codexPath = 'codex', sourceAuthPath = sourceAuth, minAuthValidityMs = 300_000,
  startupTimeoutMs = null, signal = null, appFactory = startAppServer,
} = {}) {
  if (!path.isAbsolute(workspace)) throw new TypeError('workspace must be absolute');
  if (!['apply', 'control'].includes(arm)) throw new TypeError('arm must be apply or control');
  codexPath = resolveExecutable(codexPath);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-codex-subscription-'));
  try {
    let auth;
    try { auth = JSON.parse(fs.readFileSync(sourceAuthPath, 'utf8')); }
    catch { throw authError('subscription auth is unavailable or invalid', 'SUBSCRIPTION_AUTH_INVALID'); }
    if (!hasSubscriptionAuthShape(auth)) throw new Error('ChatGPT subscription auth is required');
    if (typeof auth.OPENAI_API_KEY === 'string' && auth.OPENAI_API_KEY) throw new Error('API-key auth is outside the subscription harness');
    if (!Number.isSafeInteger(minAuthValidityMs) || minAuthValidityMs < 1) throw new TypeError('minimum auth validity must be a positive safe integer');
    if (startupTimeoutMs !== null && (!Number.isSafeInteger(startupTimeoutMs) || startupTimeoutMs < 1)) {
      throw new TypeError('startup timeout must be a positive safe integer or null');
    }
    const accessPayload = typeof auth.tokens.access_token === 'string' ? auth.tokens.access_token.split('.')[1] : null;
    let authExpiresAtMs;
    try { authExpiresAtMs = JSON.parse(Buffer.from(accessPayload, 'base64url').toString('utf8')).exp * 1000; } catch {}
    if (!Number.isFinite(authExpiresAtMs)) throw new Error('subscription auth expiry is missing or invalid');
    if (authExpiresAtMs - Date.now() < minAuthValidityMs) throw new Error('subscription auth expires too soon');
    const env = environment(root, codexPath);
    const privateAuth = { auth_mode: auth.auth_mode, tokens: auth.tokens, ...(auth.last_refresh === undefined ? {} : { last_refresh: auth.last_refresh }) };
    const privateAuthPath = path.join(env.CODEX_HOME, 'auth.json');
    fs.writeFileSync(privateAuthPath, `${JSON.stringify(privateAuth)}\n`, { mode: 0o600 });
    const initialCredentialValues = authCredentialValues(privateAuth);
    const configPath = path.join(env.CODEX_HOME, 'config.toml');
    fs.writeFileSync(configPath, `model = "gpt-6.1-sol"\nmodel_reasoning_effort = "low"\napproval_policy = "never"\nsandbox_mode = "workspace-write"\n[analytics]\nenabled = false\n`, { mode: 0o600 });
    const hookLog = path.join(root, 'hooks.jsonl');
    if (arm === 'apply') {
      const wrapper = path.join(root, 'hook-wrapper.mjs');
      fs.writeFileSync(wrapper, hookWrapperSource(hookLog), { mode: 0o700 });
      fs.writeFileSync(path.join(env.CODEX_HOME, 'hooks.json'), `${JSON.stringify(hooksConfig(wrapper), null, 2)}\n`, { mode: 0o600 });
      const app = appFactory(codexPath, { cwd: workspace, env });
      let listed;
      let operationError = null;
      const setupDeadline = startupTimeoutMs === null ? null : Date.now() + startupTimeoutMs;
      const remainingSetupMs = () => setupDeadline === null ? null : Math.max(1, setupDeadline - Date.now());
      try {
        await boundedSetup(app.initialize(), remainingSetupMs(), signal);
        listed = await boundedSetup(app.request('hooks/list', { cwds: [workspace] }), remainingSetupMs(), signal);
      } catch (error) {
        operationError = error;
        throw error;
      } finally {
        try { await app.close(); } catch (error) { if (!operationError) throw error; }
      }
      trustHooks(configPath, listed);
    }
    return {
      root, env, codexPath, hookLog, authExpiresAtMs,
      credentialValues() {
        let currentAuth;
        try { currentAuth = JSON.parse(fs.readFileSync(privateAuthPath, 'utf8')); }
        catch { throw authError('private auth credential capture failed', 'AUTH_CREDENTIAL_CAPTURE_FAILED'); }
        if (!hasSubscriptionAuthShape(currentAuth)) {
          throw authError('private auth credential capture failed', 'AUTH_CREDENTIAL_CAPTURE_FAILED');
        }
        const current = authCredentialValues(currentAuth);
        return [...new Set([...initialCredentialValues, ...current])];
      },
      cleanup() { fs.rmSync(root, { recursive: true, force: true }); },
    };
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

export async function runSubscriptionProbe({ arm = 'apply', codexPath = 'codex' } = {}) {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-subscription-workspace-'));
  const workspace = path.join(workspaceRoot, 'workspace');
  privateDirectory(workspace);
  fs.writeFileSync(path.join(workspace, 'README.md'), '# synthetic subscription probe\n');
  let prepared;
  const started = Date.now();
  try {
    prepared = await prepareSubscriptionEnvironment({ workspace, arm, codexPath });
    const result = spawnSync(prepared.codexPath, [
      'exec', '--json', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'workspace-write',
      '-m', 'gpt-6.1-sol', '-c', 'model_reasoning_effort="low"',
      "Run exactly this shell command once: printf 'SUBSCRIPTION_PROBE\\n' >> probe-marker.txt && printf 'TOOL_OK\\n'. Then reply exactly COMPLETE. Use no other tools.",
    ], { cwd: workspace, env: prepared.env, encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
    const events = parseJsonLines(result.stdout ?? '');
    const usage = events.filter((event) => event.type === 'turn.completed').at(-1)?.usage ?? null;
    const commands = events.filter((event) => event.item?.type === 'command_execution' && event.type === 'item.completed');
    const marker = fs.existsSync(path.join(workspace, 'probe-marker.txt'))
      ? fs.readFileSync(path.join(workspace, 'probe-marker.txt'), 'utf8').split('\n').filter(Boolean) : [];
    const hooks = fs.existsSync(prepared.hookLog) ? parseJsonLines(fs.readFileSync(prepared.hookLog, 'utf8')) : [];
    const pre = hooks.find((entry) => entry.mode === 'pre');
    const post = hooks.find((entry) => entry.mode === 'post');
    const usageKeys = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens'];
    const usageValues = usage && usageKeys.map((key) => usage[key]);
    const usageComplete = Boolean(usageValues?.every((value) => Number.isSafeInteger(value) && value >= 0));
    const sanitizedUsage = usageComplete ? Object.fromEntries(usageKeys.map((key) => [key, usage[key]])) : null;
    const armPassed = arm === 'apply'
      ? pre?.input?.model === 'gpt-6.1-sol' && post?.input?.tool_input?.command?.includes('sando')
      : !fs.existsSync(prepared.hookLog);
    const passed = result.status === 0 && marker.length === 1 && commands.length === 1 && usageComplete && armPassed;
    return {
      status: passed ? 'passed' : 'failed',
      codexVersion: spawnSync(prepared.codexPath, ['--version'], { env: prepared.env, encoding: 'utf8' }).stdout.trim(),
      model: pre?.input?.model ?? 'unknown',
      reasoningEffort: 'low',
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
      arm,
      durationMs: Date.now() - started,
      commandExecutions: commands.length,
      markerWrites: marker.length,
      rewriteConsumed: Boolean(post?.input?.tool_input?.command?.includes('sando')),
      usage: sanitizedUsage,
      usageQuality: usageComplete ? 'complete-safe-integers' : 'invalid',
      billing: { kind: 'chatgpt-subscription', apiCostUsd: null, status: 'unpriced' },
      authenticatedProvider: passed,
      diagnostics: passed ? undefined : { exitStatus: result.status, signal: result.signal, timedOut: result.error?.code === 'ETIMEDOUT' },
    };
  } finally {
    prepared?.cleanup();
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await runSubscriptionProbe({ arm: process.argv.includes('--control') ? 'control' : 'apply' });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status !== 'passed') process.exitCode = 1;
}
