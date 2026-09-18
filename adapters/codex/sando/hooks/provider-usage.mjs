#!/usr/bin/env node
import fs from 'node:fs';

import { currentTmuxPanePid, defaultActiveSessionPath, recordActiveSession } from '../lib/active-session.mjs';
import { pairedArmFromEnv, pairedExperimentFromEnv, pairedWorkloadFromEnv } from '../lib/paired-accounting.mjs';
import { collectProviderUsage, defaultProviderUsagePath } from '../lib/provider-usage.mjs';
import { handleStopGuard } from '../lib/runtime-guards.mjs';

async function main() {
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

    if (input.hook_event_name === 'Stop') {
      if (input.transcript_path) {
        try {
          collectProviderUsage({
            host: 'codex', transcriptPath: input.transcript_path,
            sessionId: input.session_id ?? null, turnId: input.turn_id ?? null,
            storagePath: defaultProviderUsagePath(), arm: pairedArmFromEnv(process.env),
            experimentId: pairedExperimentFromEnv(process.env), workloadId: pairedWorkloadFromEnv(process.env),
          });
        } catch {}
      }

      // Check DoneGuard
      try {
        const guardRes = await handleStopGuard({ host: 'codex', input, env: process.env });
        if (guardRes?.flagged && guardRes?.notice) {
          process.stderr.write(`\n${guardRes.notice}\n`);
          process.stdout.write(JSON.stringify({
            continue: false,
            stopReason: guardRes.notice,
            systemMessage: guardRes.notice,
          }) + '\n');
          return;
        }
      } catch {}
    }
  } catch {
    // Telemetry and guards must never crash the host.
  }
  process.stdout.write('{}\n');
}

await main();
