import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  activeSessionForPane,
  readActiveSessions,
  recordActiveSession,
} from '../src/active-session.mjs';

test('active Codex sessions are keyed by pane and process', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sando-active-session-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const storagePath = path.join(directory, 'active-sessions.json');

  assert.equal(recordActiveSession({
    sessionId: 's1', paneId: '%1', panePid: 42, storagePath,
    now: '2026-08-24T10:00:00.000Z',
  }), true);
  assert.equal(activeSessionForPane({ paneId: '%1', panePid: 42, storagePath }).sessionId, 's1');
  assert.equal(activeSessionForPane({ paneId: '%1', panePid: 43, storagePath }), undefined);

  recordActiveSession({ sessionId: 's2', paneId: '%1', panePid: 43, storagePath });
  assert.equal(activeSessionForPane({ paneId: '%1', panePid: 42, storagePath }), undefined);
  assert.equal(activeSessionForPane({ paneId: '%1', panePid: 43, storagePath }).sessionId, 's2');
  assert.equal(readActiveSessions(storagePath).entries.length, 1);
});
