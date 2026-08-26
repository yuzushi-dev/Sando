#!/usr/bin/env node
// Detached flush entrypoint: invoked with --queue and --config, nothing else.
// Never inherits provider credential env vars or contacts anything but the configured endpoint.

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { flushQueue, readTelemetryConfig } from './telemetry.mjs';

function option(argv, name) {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
}

export async function runTelemetryFlushEntry({ argv = process.argv.slice(2) } = {}) {
  const queuePath = option(argv, 'queue');
  const configPath = option(argv, 'config');
  if (!queuePath || !configPath) throw new Error('telemetry-flush-entry requires --queue and --config');
  const config = readTelemetryConfig(configPath);
  if (!config.enabled) return { sent: 0 };
  return flushQueue({ statePaths: { queue: queuePath }, endpoint: config.endpoint });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await runTelemetryFlushEntry();
}
