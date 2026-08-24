#!/usr/bin/env node

import { createProviderProxy } from '../packages/sando/src/proxy.mjs';

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

if (process.argv.includes('--help')) {
  process.stdout.write('Usage: SANDO_UPSTREAM_URL=https://provider.example npm run proxy [--port PORT] [--host HOST]\n');
  process.exit(0);
}

const upstream = option('upstream', process.env.SANDO_UPSTREAM_URL);
if (!upstream) {
  process.stderr.write('SANDO_UPSTREAM_URL or --upstream is required\n');
  process.exit(2);
}

try {
  const proxy = await createProviderProxy({
    upstream,
    host: option('host', process.env.SANDO_PROXY_HOST || '127.0.0.1'),
    port: Number(option('port', process.env.SANDO_PROXY_PORT || '0')),
    policy: process.env.SANDO_CONTEXT_POLICY ? JSON.parse(process.env.SANDO_CONTEXT_POLICY) : {},
  });
  process.stdout.write(`${JSON.stringify({ schema: 'sando-provider-proxy/v1', url: proxy.url, upstream: new URL(upstream).origin })}\n`);
  const shutdown = async () => {
    await proxy.close();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(2);
}
