#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { GATE_EVIDENCE_SCHEMA, evaluateGatewayGate } from './gateway-gate.mjs';

const MAX_INPUT_BYTES = 1 * 1024 * 1024;

function usage() {
  return 'Usage: sando context gateway-gate [--input EVIDENCE.json] [--json]\n';
}

function parseArgs(argv) {
  let args = [...argv];
  if (args[0] === 'context') args = args.slice(1);
  if (args[0] === 'gateway-gate') args = args.slice(1);
  const result = { input: undefined, json: false, help: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--help' || argument === '-h') result.help = true;
    else if (argument === '--json') result.json = true;
    else if (argument === '--input') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new Error('--input requires a value');
      result.input = value;
      index += 1;
    } else throw new Error('unknown context gateway-gate option');
  }
  return result;
}

function readEvidence(inputPath) {
  let descriptor;
  try {
    descriptor = fs.openSync(inputPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > MAX_INPUT_BYTES) throw new Error('gateway evidence is too large or not a file');
    const source = fs.readFileSync(descriptor, 'utf8');
    if (Buffer.byteLength(source, 'utf8') > MAX_INPUT_BYTES) throw new Error('gateway evidence is too large');
    try {
      return JSON.parse(source);
    } catch {
      throw new Error('gateway evidence JSON is invalid');
    }
  } catch (error) {
    if (error?.message?.startsWith('gateway evidence')) throw error;
    throw new Error('gateway evidence cannot be read');
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function emptyEvidence() {
  return { schema: GATE_EVIDENCE_SCHEMA, version: 1, hosts: [] };
}

export function formatGatewayGate(report) {
  const failed = report.checks.filter((check) => check.status !== 'pass').length;
  return [
    `Sando lazy MCP gateway: ${report.status}`,
    `hosts: ${report.hosts.map((host) => host.host).join(', ') || 'none'}`,
    `blocked checks: ${failed}`,
    `reasons: ${report.reasons.join(', ') || 'none'}`,
    `provenance: ${report.provenanceDigest}`,
  ].join('\n') + '\n';
}

export function runGatewayGateCli({ argv = process.argv.slice(2), stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    const options = parseArgs(argv);
    if (options.help) {
      stdout.write(usage());
      return null;
    }
    const evidence = options.input ? readEvidence(options.input) : emptyEvidence();
    const report = evaluateGatewayGate({ evidence });
    stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : formatGatewayGate(report));
    return report;
  } catch (error) {
    stderr.write(`sando context gateway-gate: ${error instanceof Error ? error.message : String(error)}\n${usage()}`);
    process.exitCode = 2;
    return null;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) runGatewayGateCli();
