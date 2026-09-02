#!/usr/bin/env node

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createProviderProxy } from './lib/proxy.mjs';
import { defaultProxyMetricsPath } from './lib/proxy-metrics.mjs';

function help(stdout = process.stdout) {
  stdout.write('Sando provider proxy (explicit opt-in)\n'
    + 'Required: SANDO_UPSTREAM_URL=https://api.example.test\n'
    + 'Optional: SANDO_PROXY_HOST=127.0.0.1 SANDO_PROXY_PORT=0\n'
    + '          SANDO_CONTEXT_POLICY=<JSON> SANDO_PROXY_METRICS_PATH=<absolute path>\n'
    + 'F1 capture: SANDO_CONTEXT_FOOTPRINT_PATH=<absolute path> SANDO_CONTEXT_SESSION_KEY=<key>\n');
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

async function main(argv = process.argv.slice(2), env = process.env) {
  if (argv.includes('--help') || argv.includes('-h')) {
    help();
    return;
  }
  if (!env.SANDO_UPSTREAM_URL) throw new Error('SANDO_UPSTREAM_URL is required');
  const proxy = await createProviderProxy({
    upstream: env.SANDO_UPSTREAM_URL,
    host: env.SANDO_PROXY_HOST || '127.0.0.1',
    port: numberEnv(env, 'SANDO_PROXY_PORT', 0),
    policy: policyEnv(env),
    metricsPath: env.SANDO_PROXY_METRICS_PATH || defaultProxyMetricsPath(env),
    contextCapturePath: env.SANDO_CONTEXT_FOOTPRINT_PATH,
    contextCaptureHost: env.SANDO_CONTEXT_FOOTPRINT_HOST,
    contextSessionKey: env.SANDO_CONTEXT_SESSION_KEY,
    transformProviderRequests: env.SANDO_PROXY_TRANSFORM !== '0',
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
