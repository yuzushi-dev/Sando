#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  CONTEXT_CAPTURE_SCHEMA,
  buildContextFootprintReport,
} from './context-footprint.mjs';

const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;

function usage() {
  return 'Usage: sando context audit --host claude|codex [--input CAPTURE.json] [--json]\n';
}

function parseArgs(argv) {
  let args = [...argv];
  if (args[0] === 'context') args = args.slice(1);
  if (args[0] === 'audit') args = args.slice(1);
  const result = { host: undefined, input: undefined, json: false, help: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--help' || argument === '-h') result.help = true;
    else if (argument === '--json') result.json = true;
    else if (argument === '--host' || argument === '--input') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`);
      result[argument.slice(2)] = value;
      index += 1;
    } else throw new Error('unknown context audit option');
  }
  if (!result.help && !result.host) throw new Error('--host is required');
  return result;
}

function readCapture(inputPath) {
  let descriptor;
  try {
    descriptor = fs.openSync(inputPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > MAX_CAPTURE_BYTES) throw new Error('capture input is too large or not a file');
    const source = fs.readFileSync(descriptor, 'utf8');
    if (Buffer.byteLength(source, 'utf8') > MAX_CAPTURE_BYTES) throw new Error('capture input is too large');
    try {
      return JSON.parse(source);
    } catch {
      throw new Error('capture JSON is invalid');
    }
  } catch (error) {
    if (error?.message === 'capture JSON is invalid' || error?.message === 'capture input is too large or not a file'
      || error?.message === 'capture input is too large') throw error;
    throw new Error('capture input cannot be read');
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function unavailableCapture(host) {
  return { schema: CONTEXT_CAPTURE_SCHEMA, host, body: { state: 'unavailable' } };
}

export function formatContextFootprintReport(report) {
  const attribution = report.attribution.status === 'unavailable'
    ? 'unavailable'
    : `${report.attribution.status} (${report.attribution.bodyBytes}B, unknown ${report.attribution.unknownBytes}B)`;
  const estimated = report.tokenAccounting.estimated.totalTokens === null
    ? 'unavailable'
    : String(report.tokenAccounting.estimated.totalTokens);
  const provider = report.tokenAccounting.providerReported?.inputTokens === undefined
    ? 'unavailable'
    : String(report.tokenAccounting.providerReported.inputTokens);
  return [
    `Sando context audit: ${report.host}/${report.requestFormat ?? 'format unavailable'}`,
    `body: ${report.observation.status}`,
    `attribution: ${attribution}`,
    `tool search: ${report.toolSearch.state}`,
    `estimated input tokens: ${estimated}`,
    `provider input tokens: ${provider}`,
    `provenance: ${report.provenanceDigest}`,
  ].join('\n') + '\n';
}

export function runContextAuditCli({ argv = process.argv.slice(2), stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    const options = parseArgs(argv);
    if (options.help) {
      stdout.write(usage());
      return null;
    }
    const capture = options.input ? readCapture(options.input) : unavailableCapture(options.host);
    if (capture?.host !== options.host) throw new Error('capture host does not match --host');
    const report = buildContextFootprintReport(capture);
    stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : formatContextFootprintReport(report));
    return report;
  } catch (error) {
    stderr.write(`sando context audit: ${error instanceof Error ? error.message : String(error)}\n${usage()}`);
    process.exitCode = 2;
    return null;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) runContextAuditCli();
