#!/usr/bin/env node

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadProjectRedactionProfile } from './lib/redaction-config.mjs';
import { createProviderProxy } from './lib/proxy.mjs';
import { defaultProxyMetricsPath } from './lib/proxy-metrics.mjs';
import { createSemanticJudge } from './lib/semantic-judge.mjs';

function help(stdout = process.stdout) {
  stdout.write('Sando provider proxy (explicit opt-in)\n'
    + 'Required: SANDO_UPSTREAM_URL=https://api.example.test\n'
    + 'Optional: SANDO_PROXY_HOST=127.0.0.1 SANDO_PROXY_PORT=0\n'
    + '          SANDO_CONTEXT_POLICY=<JSON> SANDO_PROXY_METRICS_PATH=<absolute path>\n'
    + 'History archive: SANDO_HISTORY_ARCHIVE_ROOT=<absolute workspace path>\n'
    + 'F1 capture: SANDO_CONTEXT_FOOTPRINT_PATH=<absolute path> SANDO_CONTEXT_SESSION_KEY=<key>\n'
    + 'TypeSafe shadow: SANDO_TYPESAFE_SHADOW=1 (optional pi-typesafe package)\n');
}

function numberEnv(env, name, fallback) {
  if (env[name] === undefined || env[name] === '') return fallback;
  const value = Number(env[name]);
  if (!Number.isInteger(value) || value < 0 || value > 65535) throw new TypeError(`${name} is invalid`);
  return value;
}

function policyEnv(env) {
  if (!env.SANDO_CONTEXT_POLICY) return {};
  const value = JSON.parse(env.SANDO_CONTEXT_POLICY);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('SANDO_CONTEXT_POLICY must be a JSON object');
  return value;
}

function boundedEnv(env, name, fallback, minimum, maximum) {
  if (env[name] === undefined || env[name] === '') return fallback;
  const value = Number(env[name]);
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new TypeError(`${name} is invalid`);
  return value;
}

async function optionalTypesafeJudge(env) {
  if (env.SANDO_TYPESAFE_SHADOW !== '1') return null;
  try {
    const typesafe = await import('pi-typesafe');
    const auth = typeof typesafe.authState === 'function' ? typesafe.authState() : null;
    const situation = auth === null && typeof typesafe.keySituation === 'function' ? typesafe.keySituation() : null;
    if (auth ? auth.usable !== true : situation?.kind === 'missing' || situation?.kind === 'unusable') {
      process.stderr.write('sando typesafe judge disabled: no usable TypeSafe key\n');
      return null;
    }
    const timeoutMs = boundedEnv(env, 'SANDO_TYPESAFE_TIMEOUT_MS', 1500, 50, 15000);
    const maxRequests = boundedEnv(env, 'SANDO_TYPESAFE_MAX_REQUESTS', 20, 1, 1000);
    const profile = loadProjectRedactionProfile(env.SANDO_PROJECT_ROOT || process.cwd()).profile;
    const client = typesafe.createTypeSafe({ timeoutMs, maxRequests });
    return createSemanticJudge({
      evaluate: (request, options) => client.evaluate(request, options),
      policy: { timeoutMs, maxRequests },
      redactionProfile: profile,
    });
  } catch (error) {
    process.stderr.write(`sando typesafe judge disabled: ${error instanceof Error ? error.message : String(error)}\n`);
    return null;
  }
}

async function main(argv = process.argv.slice(2), env = process.env) {
  if (argv.includes('--help') || argv.includes('-h')) {
    help();
    return;
  }
  if (!env.SANDO_UPSTREAM_URL) throw new Error('SANDO_UPSTREAM_URL is required');
  const semanticJudge = await optionalTypesafeJudge(env);
  const proxy = await createProviderProxy({
    upstream: env.SANDO_UPSTREAM_URL,
    host: env.SANDO_PROXY_HOST || '127.0.0.1',
    port: numberEnv(env, 'SANDO_PROXY_PORT', 0),
    policy: policyEnv(env),
    metricsPath: env.SANDO_PROXY_METRICS_PATH || defaultProxyMetricsPath(env),
    contextCapturePath: env.SANDO_CONTEXT_FOOTPRINT_PATH,
    contextCaptureHost: env.SANDO_CONTEXT_FOOTPRINT_HOST,
    contextSessionKey: env.SANDO_CONTEXT_SESSION_KEY,
    transformProviderRequests: env.SANDO_PROXY_TRANSFORM === '1',
    historyArchiveRoot: env.SANDO_HISTORY_ARCHIVE_ROOT,
    semanticJudge,
    env,
  });
  process.stdout.write(`${JSON.stringify({
    schema: 'sando-provider-proxy/v1', url: proxy.url, metricsPath: env.SANDO_PROXY_METRICS_PATH || defaultProxyMetricsPath(env),
    contextCapturePath: env.SANDO_CONTEXT_FOOTPRINT_PATH || null,
  })}\n`);
  await new Promise((resolve) => {
    const stop = async () => { await proxy.close(); resolve(); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`sando proxy: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  });
}
