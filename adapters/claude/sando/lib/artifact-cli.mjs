#!/usr/bin/env node

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { recoverArtifactFromWorkspace } from './artifact-recovery.mjs';

function usage() {
  return 'Usage: sando artifact get --ref HANDLE [--root DIR] [--start-byte N --end-byte N | --start-line N --end-line N] [--max-bytes N] [--json]\n';
}

function number(value, name) {
  if (!/^\d+$/.test(value ?? '')) throw new Error(`${name} must be a non-negative integer`);
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new Error(`${name} is too large`);
  return result;
}

function parseArgs(argv) {
  let args = [...argv];
  if (args[0] === 'artifact') args = args.slice(1);
  if (args[0] === 'get') args = args.slice(1);
  const result = { root: process.cwd(), json: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--json') result.json = true;
    else if (argument === '--help' || argument === '-h') result.help = true;
    else if (['--root', '--ref', '--start-byte', '--end-byte', '--start-line', '--end-line', '--max-bytes'].includes(argument)) {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`);
      const key = argument.slice(2).replaceAll('-', '');
      result[key] = ['startbyte', 'endbyte', 'startline', 'endline', 'maxbytes'].includes(key)
        ? number(value, argument)
        : value;
      index += 1;
    } else throw new Error('unknown artifact option');
  }
  if (!result.help && !result.ref) throw new Error('--ref is required');
  if (!result.help && ((result.startbyte !== undefined) !== (result.endbyte !== undefined)
    || (result.startline !== undefined) !== (result.endline !== undefined))) throw new Error('artifact ranges require start and end');
  return result;
}

function terminal(report) {
  return `Sando artifact ${report.handle}: ${report.bytes}B${report.truncated ? ' (bounded)' : ''}\n${report.content}\n`;
}

export function runArtifactCli({ argv = process.argv.slice(2), stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    const options = parseArgs(argv);
    if (options.help) { stdout.write(usage()); return null; }
    const report = recoverArtifactFromWorkspace({
      cwd: path.resolve(options.root), ref: options.ref,
      ...(options.startbyte !== undefined ? { startByte: options.startbyte, endByte: options.endbyte } : {}),
      ...(options.startline !== undefined ? { startLine: options.startline, endLine: options.endline } : {}),
      ...(options.maxbytes !== undefined ? { maxBytes: options.maxbytes } : {}),
    });
    stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : terminal(report));
    return report;
  } catch (error) {
    stderr.write(`sando artifact get: ${error instanceof Error ? error.message : String(error)}\n${usage()}`);
    process.exitCode = 2;
    return null;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) runArtifactCli();
