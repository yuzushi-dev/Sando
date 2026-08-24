#!/usr/bin/env node

import fs from 'node:fs';

import { currentTmuxPanePid, defaultActiveSessionPath, recordActiveSession } from '../lib/active-session.mjs';
import { runPreToolUse } from '../lib/enforcement.mjs';

let output = {};
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
  output = runPreToolUse(input);
} catch {}
process.stdout.write(`${JSON.stringify(output)}\n`);
