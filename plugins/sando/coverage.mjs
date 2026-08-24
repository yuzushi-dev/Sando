#!/usr/bin/env node

import { readCoverage } from './lib/coverage.mjs';

process.stdout.write(`${JSON.stringify(readCoverage(), null, 2)}\n`);
