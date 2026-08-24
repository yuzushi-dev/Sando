#!/usr/bin/env node
import {
  activeSessionForPane,
  currentTmuxPanePid,
} from '../packages/sando/index.mjs';
import { readStatusSnapshot, renderStatusLine } from '../packages/sando/index.mjs';

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

try {
  const paneId = option('--pane') || process.env.TMUX_PANE;
  const sessionId = process.env.SANDO_CODEX_SESSION_ID
    || activeSessionForPane({ paneId, panePid: currentTmuxPanePid(paneId) })?.sessionId;
  if (!sessionId) {
    process.stdout.write('🥪 —\n');
    process.exit(0);
  }
  process.stdout.write(`${renderStatusLine(readStatusSnapshot({
    host: 'codex', sessionId,
  }))}\n`);
} catch {
  process.stdout.write('🥪 —\n');
}
