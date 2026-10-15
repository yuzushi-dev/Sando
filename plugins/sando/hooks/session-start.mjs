import fs from 'node:fs';

import { runSessionStart } from '../lib/session-start.mjs';

let input = '';
try { input = fs.readFileSync(0, 'utf8'); } catch { /* no stdin: no session id to record */ }
runSessionStart({ rootEnv: 'PLUGIN_ROOT', input });
