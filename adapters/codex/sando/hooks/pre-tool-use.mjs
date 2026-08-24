#!/usr/bin/env node

import fs from 'node:fs';

import { runPreToolUse } from '../lib/enforcement.mjs';

let output = {};
try { output = runPreToolUse(JSON.parse(fs.readFileSync(0, 'utf8') || '{}')); } catch {}
process.stdout.write(`${JSON.stringify(output)}\n`);
