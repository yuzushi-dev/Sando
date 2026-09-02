#!/usr/bin/env node

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { buildInstructionPlan } from './instruction-plan.mjs';

function usage() {
  return 'Usage: sando context plan-instructions [--root DIR] [--host claude|codex|both] [--json]\n';
}

function parseArgs(argv) {
  let args = [...argv];
  if (args[0] === 'context') args = args.slice(1);
  if (args[0] === 'plan-instructions') args = args.slice(1);
  const result = { root: process.cwd(), host: 'both', json: false, help: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--help' || argument === '-h') result.help = true;
    else if (argument === '--json') result.json = true;
    else if (argument === '--apply') throw new Error('--apply is not supported; this command is preview-only');
    else if (argument === '--root' || argument === '--host') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`);
      result[argument.slice(2)] = value;
      index += 1;
    } else throw new Error('unknown instruction-plan option');
  }
  return result;
}

export function formatInstructionPlanReport(report) {
  const { summary } = report;
  const lines = [
    `Sando instruction plan: host=${report.host}`,
    `files: ${report.files.length}; blocks: ${report.blocks.length}`,
    `always-on: ${summary.alwaysOnBytes}B; on-demand: ${summary.onDemandBytes}B; unknown: ${summary.unknownBytes}B`,
    `proposals: ${report.proposals.length} (${summary.proposedBytes}B, preview only)`,
  ];
  for (const proposal of report.proposals) {
    lines.push(`- ${proposal.blockId} ${proposal.source.path}:${proposal.source.startLine}-${proposal.source.endLine} -> ${proposal.destination.name}`);
  }
  lines.push(`provenance: ${report.provenanceDigest}`);
  return `${lines.join('\n')}\n`;
}

export function runInstructionPlanCli({ argv = process.argv.slice(2), stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    const options = parseArgs(argv);
    if (options.help) {
      stdout.write(usage());
      return null;
    }
    const report = buildInstructionPlan({ root: options.root, host: options.host });
    stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : formatInstructionPlanReport(report));
    return report;
  } catch (error) {
    stderr.write(`sando context plan-instructions: ${error instanceof Error ? error.message : String(error)}\n${usage()}`);
    process.exitCode = 2;
    return null;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) runInstructionPlanCli();
