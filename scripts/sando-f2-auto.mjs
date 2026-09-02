#!/usr/bin/env node

import { runF2AutomationCli } from '../packages/sando/src/instruction-plan-automation.mjs';
import { publishF2Telemetry } from '../packages/sando/src/f2-telemetry.mjs';

const result = runF2AutomationCli();
if (result) {
  try {
    const published = await publishF2Telemetry({ result });
    process.stderr.write(`Sando F2 telemetry: sent=${published.events}\n`);
  } catch (error) {
    process.stderr.write(`Sando F2 telemetry unavailable: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}
