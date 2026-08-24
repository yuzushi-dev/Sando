#!/usr/bin/env node
import { readStatusSnapshot, renderStatusLine } from '../packages/sando/index.mjs';

try {
  process.stdout.write(`${renderStatusLine(readStatusSnapshot())}\n`);
} catch {
  process.stdout.write('🥪 —\n');
}
