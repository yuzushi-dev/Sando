#!/usr/bin/env node

import os from 'node:os';
import path from 'node:path';

const stateHome = path.join(os.homedir(), '.local', 'state', 'sando', 'canary');
process.env.SANDO_PROVIDER_USAGE_PATH ||= path.join(stateHome, 'provider-usage.json');
process.env.SANDO_METRICS_PATH ||= path.join(stateHome, 'metrics.json');

const { runCanaryCli } = await import('../packages/sando/src/canary.mjs');
runCanaryCli();
