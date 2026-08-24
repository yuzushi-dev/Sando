#!/usr/bin/env node
import fs from 'node:fs';

import { currentTmuxPanePid, defaultActiveSessionPath, recordActiveSession } from '../lib/active-session.mjs';
import { collectProviderUsage, defaultProviderUsagePath } from '../lib/provider-usage.mjs';

try {
  const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  try {
    const paneId = process.env.TMUX_PANE;
    recordActiveSession({
      sessionId: input.session_id ?? input.sessionId,
      paneId,
      panePid: currentTmuxPanePid(paneId),
      storagePath: defaultActiveSessionPath(),
    });
  } catch {}
  if (input.hook_event_name === 'Stop' && input.transcript_path) {
    collectProviderUsage({
      host: 'codex', transcriptPath: input.transcript_path,
      sessionId: input.session_id ?? null, turnId: input.turn_id ?? null,
      storagePath: defaultProviderUsagePath(),
    });
  }
} catch {
  // Telemetry must never stop the host.
}

process.stdout.write('{}\n');
