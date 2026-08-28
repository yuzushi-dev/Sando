import fs from 'node:fs';
import path from 'node:path';

import { createRedactionProfile } from './redaction-profile.mjs';

const MAX_CONFIG_BYTES = 64 * 1024;
const cache = new Map();
const builtInProfile = createRedactionProfile([]);

function lstatIfPresent(target) {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function readBoundedFile(configPath, expectedStat) {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  const descriptor = fs.openSync(configPath, flags);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw new Error(`redaction config is not a regular file: ${configPath}`);
    if (stat.dev !== expectedStat.dev || stat.ino !== expectedStat.ino) {
      throw new Error(`redaction config changed while opening: ${configPath}`);
    }
    if (stat.size > MAX_CONFIG_BYTES) {
      throw new Error(`redaction config exceeds 64 KiB: ${configPath}`);
    }

    const content = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < content.length) {
      const count = fs.readSync(descriptor, content, bytesRead, content.length - bytesRead, null);
      if (count === 0) break;
      bytesRead += count;
    }
    if (bytesRead > MAX_CONFIG_BYTES) {
      throw new Error(`redaction config exceeds 64 KiB: ${configPath}`);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(content.subarray(0, bytesRead));
  } finally {
    fs.closeSync(descriptor);
  }
}

function parseConfig(source, configPath) {
  let config;
  try {
    config = JSON.parse(source);
  } catch (error) {
    throw new Error(`invalid JSON in redaction config ${configPath}: ${error.message}`, { cause: error });
  }

  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error(`invalid redaction config schema: ${configPath}`);
  }
  const keys = Object.keys(config).sort();
  if (keys.length !== 2 || keys[0] !== 'rules' || keys[1] !== 'schema'
      || config.schema !== 'sando-redaction/v1' || !Array.isArray(config.rules)) {
    throw new Error(`invalid redaction config schema: ${configPath}`);
  }
  return config;
}

export function loadProjectRedactionProfile(cwd) {
  try {
    return loadProjectRedactionProfileUnsafe(cwd);
  } catch (error) {
    if (error?.code === 'SANDO_REDACTION_CONFIG') throw error;
    const wrapped = new Error(error instanceof Error ? error.message : String(error), { cause: error });
    wrapped.code = 'SANDO_REDACTION_CONFIG';
    throw wrapped;
  }
}

function loadProjectRedactionProfileUnsafe(cwd) {
  const configDirectory = path.resolve(cwd, '.sando');
  const directoryStat = lstatIfPresent(configDirectory);
  if (!directoryStat) return { profile: builtInProfile, path: null };
  if (directoryStat.isSymbolicLink()) {
    throw new Error(`redaction config directory must not be a symlink: ${configDirectory}`);
  }
  if (!directoryStat.isDirectory()) {
    throw new Error(`redaction config directory is not a directory: ${configDirectory}`);
  }

  const configPath = path.join(configDirectory, 'redaction.json');
  const stat = lstatIfPresent(configPath);
  if (!stat) return { profile: builtInProfile, path: null };
  if (stat.isSymbolicLink()) throw new Error(`redaction config must not be a symlink: ${configPath}`);
  if (!stat.isFile()) throw new Error(`redaction config is not a regular file: ${configPath}`);
  if (stat.size > MAX_CONFIG_BYTES) throw new Error(`redaction config exceeds 64 KiB: ${configPath}`);

  const cached = cache.get(configPath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.result;

  const source = readBoundedFile(configPath, stat);
  const config = parseConfig(source, configPath);
  const result = { profile: createRedactionProfile(config.rules), path: configPath };
  cache.set(configPath, { mtimeMs: stat.mtimeMs, size: stat.size, result });
  return result;
}
