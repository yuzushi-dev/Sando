import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { createReceipt, normalizeEvent, normalizePolicy, optimizeToolOutput } from './core.mjs';
import { defaultMetricsPath, recordMetrics } from './metrics.mjs';

function hookPolicy(env) {
  if (env.SANDO_POLICY) return normalizePolicy(JSON.parse(env.SANDO_POLICY));
  return normalizePolicy({ mode: env.SANDO_MODE || 'observe' });
}

function artifactPath(cwd, artifact) {
  const root = fs.realpathSync(cwd);
  const stateRoot = path.join(root, '.sando');
  const privateRoot = path.join(stateRoot, 'sando');
  const directory = path.join(privateRoot, 'artifacts');
  for (const target of [stateRoot, privateRoot, directory]) {
    const stat = fs.lstatSync(target, { throwIfNoEntry: false });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error('artifact directory is unsafe');
    if (!stat) fs.mkdirSync(target, { mode: 0o700 });
  }
  const name = `${artifact.sourceDigest.slice('sha256:'.length)}.txt`;
  const destination = path.join(directory, name);
  const temporary = path.join(directory, `.${name}.${process.pid}.${randomUUID()}`);
  try {
    fs.writeFileSync(temporary, artifact.content, { flag: 'wx', mode: 0o600 });
    try { fs.linkSync(temporary, destination); }
    catch (error) {
      if (error?.code !== 'EEXIST' || fs.readFileSync(destination, 'utf8') !== artifact.content) throw error;
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  fs.chmodSync(destination, 0o600);
  return path.posix.join('.sando/sando', 'artifacts', name);
}

export function runHookCli({ host, env = process.env } = {}) {
  let policy;
  try {
    policy = hookPolicy(env);
  } catch (error) {
    process.stderr.write(`sando invalid policy: ${error instanceof Error ? error.message : 'invalid input'}\n`);
    process.exitCode = 2;
    return;
  }
  try {
    const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
    const eventName = input.hook_event_name ?? input.hookEventName ?? input.event_name ?? input.eventName;
    if (eventName === 'PostToolUse') {
      const event = normalizeEvent(input);
      const optimization = optimizeToolOutput({ toolName: event.toolName, output: event.output, cwd: event.cwd, policy });
      const receipt = createReceipt({ host, event, optimization });
      try { recordMetrics({ storagePath: defaultMetricsPath(env), host, event, optimization, receipt }); } catch {}
      if (host === 'claude' && policy.mode === 'apply') {
        const shaped = shapeForClaude({
          original: event.output,
          optimization,
          toolName: event.toolName,
          cwd: event.cwd,
          policy,
        });
        if (shaped !== undefined) {
          process.stdout.write(`${JSON.stringify({ hookSpecificOutput: {
            hookEventName: 'PostToolUse', updatedToolOutput: shaped,
          } })}\n`);
          return;
        }
      }
    }
  } catch {}
  process.stdout.write('{}\n');
}

function materialize(optimization, cwd) {
  if (!optimization.artifact) return optimization.inline;
  return optimization.inline.replace(optimization.artifact.ref, artifactPath(cwd, optimization.artifact));
}

function shapeForClaude({ original, optimization, toolName, cwd, policy }) {
  if (typeof original === 'string') return materialize(optimization, cwd);
  if (!original || typeof original !== 'object' || Array.isArray(original)
    || !Object.hasOwn(original, 'stdout') || !Object.hasOwn(original, 'stderr')) return undefined;
  const result = { ...original };
  if (typeof original.stdout === 'string') {
    result.stdout = materialize(optimizeToolOutput({ toolName, output: original.stdout, cwd, policy }), cwd);
  }
  if (typeof original.stderr === 'string') {
    result.stderr = materialize(optimizeToolOutput({ toolName, output: original.stderr, cwd, policy }), cwd);
  }
  return result;
}
