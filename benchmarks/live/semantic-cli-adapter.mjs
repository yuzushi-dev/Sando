import { execFileSync, spawn } from 'node:child_process';

import { formatChildFailure, parseClaudeUsage, parseCodexUsage } from './adapters.mjs';

export const SEMANTIC_PROVIDERS = Object.freeze(['codex', 'claude']);
export const DEFAULT_SEMANTIC_MODELS = Object.freeze({
  codex: 'gpt-5.6-luna',
  claude: 'claude-haiku-4-5',
});

const SEMANTIC_CLI_JSON_SCHEMA = JSON.stringify({
  type: 'object',
  additionalProperties: false,
  required: ['schema', 'summary', 'preservedFacts'],
  properties: {
    schema: { const: 'sando-semantic-summary/v1' },
    summary: { type: 'string' },
    preservedFacts: { type: 'array', items: { type: 'string' } },
  },
});

export const SEMANTIC_SYSTEM_PROMPT = 'You are a semantic compactor. Follow the user request exactly. Return one JSON object only; never ask clarifying questions; never discuss plans.';

function jsonDocuments(stdout) {
  if (typeof stdout !== 'string' || !stdout.trim()) return null;
  try { return [JSON.parse(stdout)]; } catch {}
  const documents = [];
  for (const line of stdout.trim().split('\n')) {
    try { documents.push(JSON.parse(line)); } catch { return null; }
  }
  return documents.length ? documents : null;
}

function parseResponse(value) {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return null; }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function unavailable(provider) {
  throw new Error(`${provider} semantic provider is unavailable`);
}

export function selectSemanticProvider({ requested = 'auto', codexAvailable, claudeAvailable } = {}) {
  if (!['auto', ...SEMANTIC_PROVIDERS].includes(requested)) {
    throw new TypeError(`unknown semantic provider: ${requested}`);
  }
  const available = { codex: codexAvailable === true, claude: claudeAvailable === true };
  if (requested !== 'auto') {
    if (!available[requested]) unavailable(requested);
    return { provider: requested, fallback: false };
  }
  if (available.codex) return { provider: 'codex', fallback: false };
  if (available.claude) return { provider: 'claude', fallback: true };
  throw new Error('no semantic provider available (need codex or claude)');
}

export function buildSemanticCliArgs({ provider, model, maxBudgetUsd } = {}) {
  if (!SEMANTIC_PROVIDERS.includes(provider)) throw new TypeError(`unknown semantic provider: ${provider}`);
  if (provider === 'codex') {
    return [
      '--ask-for-approval', 'never', 'exec',
      ...(model ? ['--model', model] : []),
      '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check',
      '--sandbox', 'read-only', '--color', 'never', '--json', '-',
    ];
  }
  return [
    '--print', '--no-session-persistence', '--disable-slash-commands', '--no-chrome', '--safe-mode',
    '--system-prompt', SEMANTIC_SYSTEM_PROMPT,
    '--setting-sources', '', '--tools', '', '--permission-mode', 'dontAsk', '--output-format', 'json',
    '--json-schema', SEMANTIC_CLI_JSON_SCHEMA,
    ...(model ? ['--model', model] : []),
    ...(maxBudgetUsd === undefined ? [] : ['--max-budget-usd', String(maxBudgetUsd)]),
  ];
}

export function buildSemanticEnv(source = {}) {
  const env = { ...source };
  for (const key of Object.keys(env)) {
    if (key.startsWith('SANDO_')) delete env[key];
  }
  delete env.ANTHROPIC_BASE_URL;
  delete env.OPENAI_BASE_URL;
  return env;
}

export function discoverSemanticProviders({ codexCommand = 'codex', claudeCommand = 'claude' } = {}) {
  const available = (command) => {
    try {
      execFileSync(command, ['--version'], { stdio: 'ignore', timeout: 5_000 });
      return true;
    } catch {
      return false;
    }
  };
  return {
    codexAvailable: available(codexCommand),
    claudeAvailable: available(claudeCommand),
  };
}

export function parseSemanticCliOutput({ provider, stdout } = {}) {
  if (!SEMANTIC_PROVIDERS.includes(provider)) throw new TypeError(`unknown semantic provider: ${provider}`);
  const documents = jsonDocuments(stdout);
  if (!documents?.length) throw new Error(`${provider} returned non-JSON semantic output`);

  let response;
  let usage;
  if (provider === 'codex') {
    const assistant = documents.slice().reverse().find((document) =>
      document?.type === 'item.completed' && document.item?.type === 'agent_message');
    response = parseResponse(assistant?.item?.text);
    usage = parseCodexUsage(stdout);
  } else {
    const terminal = documents.slice().reverse().find((document) =>
      document?.type === 'result' && document?.subtype === 'success');
    response = parseResponse(terminal?.structured_output ?? terminal?.result);
    usage = parseClaudeUsage(stdout, { tolerateMalformed: true });
  }
  if (!response || !usage) throw new Error(`${provider} returned an invalid semantic response or usage`);
  return { ...response, usage };
}

function runChild({ command, args, input, cwd, env, timeoutMs, signal, provider }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer;

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      callback(value);
    };
    const stop = (error) => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1_000).unref();
      finish(reject, error);
    };
    const abort = () => {
      const error = new Error('semantic compactor timeout');
      error.code = 'SEMANTIC_TIMEOUT';
      stop(error);
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => finish(reject, error));
    child.on('close', (code, childSignal) => {
      if (settled) return;
      if (code !== 0) {
        const result = { code, signal: childSignal, stdout, stderr };
        finish(reject, new Error(formatChildFailure(provider, 'semantic', result)));
        return;
      }
      try { finish(resolve, parseSemanticCliOutput({ provider, stdout })); } catch (error) { finish(reject, error); }
    });
    timer = setTimeout(() => {
      const error = new Error('semantic compactor timeout');
      error.code = 'SEMANTIC_TIMEOUT';
      stop(error);
    }, timeoutMs);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    child.stdin.end(input);
  });
}

export function createCliSemanticCompleter({
  provider = 'auto',
  model,
  cwd = process.cwd(),
  timeoutMs = 120_000,
  maxBudgetUsd = 0.05,
  codexCommand = 'codex',
  claudeCommand = 'claude',
  env = process.env,
  availability,
} = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('timeoutMs must be positive');
  let selected;
  const resolve = () => {
    if (selected) return selected;
    const detected = availability ?? discoverSemanticProviders({ codexCommand, claudeCommand });
    selected = selectSemanticProvider({ requested: provider, ...detected });
    return selected;
  };

  const complete = async ({ prompt, signal } = {}) => {
    if (typeof prompt !== 'string' || !prompt) throw new TypeError('semantic prompt is required');
    const actual = resolve().provider;
    const actualModel = model ?? DEFAULT_SEMANTIC_MODELS[actual];
    return runChild({
      command: actual === 'codex' ? codexCommand : claudeCommand,
      args: buildSemanticCliArgs({ provider: actual, model: actualModel, maxBudgetUsd }),
      input: prompt,
      cwd,
      env: buildSemanticEnv(env),
      timeoutMs,
      signal,
      provider: actual,
    });
  };
  Object.defineProperties(complete, {
    provider: { get: () => selected?.provider ?? null },
    model: { get: () => model ?? (selected ? DEFAULT_SEMANTIC_MODELS[selected.provider] : null) },
  });
  return complete;
}
