#!/usr/bin/env node

import { runHookCli } from '../lib/hook-entry.mjs';

await runHookCli({ host: 'codex' });
