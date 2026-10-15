#!/usr/bin/env node
// Informational only: never blocks, prompts, or makes a network call.
import fs from 'node:fs';

import { runSessionStart } from '../lib/session-start.mjs';

let input = '';
try { input = fs.readFileSync(0, 'utf8'); } catch { /* no stdin: no session id to record */ }
runSessionStart({ rootEnv: 'CLAUDE_PLUGIN_ROOT', input });
