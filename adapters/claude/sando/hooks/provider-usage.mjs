#!/usr/bin/env node
import fs from 'node:fs';

import { collectProviderUsage, defaultProviderUsagePath } from '../lib/provider-usage.mjs';

try {
  const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  if (input.hook_event_name === 'Stop' && input.transcript_path) {
    collectProviderUsage({
      host: 'claude', transcriptPath: input.transcript_path,
      sessionId: input.session_id ?? null, turnId: input.turn_id ?? null,
      storagePath: defaultProviderUsagePath(),
    });
  }
} catch {
  // Telemetry must never stop the host.
}

process.stdout.write('{}\n');
