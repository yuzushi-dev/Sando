#!/usr/bin/env node

import { detectCodexHost, probeCodexCapabilities } from './lib/codex-capabilities.mjs';

process.stdout.write(`${JSON.stringify(probeCodexCapabilities(detectCodexHost()), null, 2)}\n`);
