#!/usr/bin/env node
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

import { readStatusSnapshot, renderStatusLine } from './lib/statusline.mjs';

let input = '';
try { input = fs.readFileSync(0, 'utf8'); } catch {}

function claudeStatusContext(value) {
  try {
    const status = JSON.parse(value || '{}');
    const sessionId = typeof status.session_id === 'string' ? status.session_id : undefined;
    const model = typeof status.model === 'string' ? status.model : status.model?.id ?? status.model?.display_name;
    return { host: 'claude', sessionId, model };
  } catch {
    return { host: 'claude' };
  }
}

function honeyStatus() {
  const script = process.env.SANDO_HONEY_STATUSLINE;
  if (!script) return '';
  try {
    const nodeScript = /\.(?:c|m)?js$/.test(script) && !/[\s]/.test(script);
    const result = spawnSync(nodeScript ? process.execPath : 'sh', nodeScript ? [script] : ['-c', script], {
      input, encoding: 'utf8', timeout: 250,
      env: process.env,
    });
    return result.status === 0 ? result.stdout.trim() : '';
  } catch {
    return '';
  }
}

try {
  const parts = [honeyStatus(), renderStatusLine(readStatusSnapshot(claudeStatusContext(input)))].filter(Boolean);
  process.stdout.write(`${parts.join(' · ')}\n`);
} catch {
  process.stdout.write('🥪 —\n');
}
