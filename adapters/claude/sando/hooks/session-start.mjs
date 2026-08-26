#!/usr/bin/env node
// Informational only: never blocks, prompts, or makes a network call.
import { runSessionStart } from '../lib/session-start.mjs';

runSessionStart({ rootEnv: 'CLAUDE_PLUGIN_ROOT' });
