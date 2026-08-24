#!/usr/bin/env node
import {
  activeSessionForPane,
  currentTmuxPanePid,
} from './lib/active-session.mjs';
import { readStatusSnapshot, renderStatusLine } from './lib/statusline.mjs';

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

try {
  const paneId = option('--pane') || process.env.TMUX_PANE;
  const sessionId = process.env.SANDO_CODEX_SESSION_ID
    || activeSessionForPane({ paneId, panePid: currentTmuxPanePid(paneId) })?.sessionId;
  process.stdout.write(`${sessionId
    ? renderStatusLine(readStatusSnapshot({ host: 'codex', sessionId }))
    : '🥪 —'}\n`);
} catch {
  process.stdout.write('🥪 —\n');
}
