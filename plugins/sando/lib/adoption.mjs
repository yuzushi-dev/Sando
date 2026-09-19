import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { atomicWrite, ensureDirectory, withLock } from './provider-usage.mjs';
import { PLUGIN_VERSION } from './version.mjs';

export const ADOPTION_SCHEMA_VERSION = 1;
export const ADOPTION_CONSENT_VERSION = 1;
export const ADOPTION_ENDPOINT = 'https://telemetry.yuzushi.party/v1/logs';
const MAX_QUEUE = 256;
const MAX_STRING = 32;
const HOSTS = new Set(['claude', 'codex', 'omp']);
const VERSION = /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})(?:[-+][0-9A-Za-z.-]{1,12})?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
let flushScheduled = false;

function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function configEmpty() { return { schema_version: ADOPTION_SCHEMA_VERSION, enabled: false, consent_state: 'unasked' }; }
function validateConfig(value) {
  if (!record(value) || value.schema_version !== ADOPTION_SCHEMA_VERSION || typeof value.enabled !== 'boolean'
    || !['unasked', 'enabled', 'declined'].includes(value.consent_state)) throw new Error('adoption config is invalid');
  if (value.enabled && (value.consent_version !== ADOPTION_CONSENT_VERSION
    || typeof value.consented_at !== 'string' || Number.isNaN(Date.parse(value.consented_at)))) throw new Error('adoption config is invalid');
  return value;
}
function validateVersion(value) { if (typeof value !== 'string' || !VERSION.test(value) || value.length > MAX_STRING) throw new Error('invalid plugin version'); }
function validateHost(value) { if (!HOSTS.has(value)) throw new Error('invalid adoption host'); }
function validateUuid(value) { if (!UUID.test(value)) throw new Error('invalid installation id'); }
function dateParts(at) {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) throw new Error('invalid observation time');
  if (date.getTime() > Date.now() + 5 * 60_000) throw new Error('observation time is in the future');
  return { date, day: date.toISOString().slice(0, 10), nano: String(BigInt(date.getTime()) * 1_000_000n) };
}

export function defaultAdoptionConfigPath(env = process.env) {
  const home = env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  if (!path.isAbsolute(home)) throw new Error('config directory must be absolute');
  return path.join(home, 'sando', 'adoption.json');
}
export function defaultAdoptionStatePath(env = process.env) {
  const home = env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  if (!path.isAbsolute(home)) throw new Error('state directory must be absolute');
  return path.join(home, 'sando', 'adoption.json');
}
export function readAdoptionConfig(configPath = defaultAdoptionConfigPath()) {
  if (!fs.existsSync(configPath)) return configEmpty();
  return validateConfig(JSON.parse(fs.readFileSync(configPath, 'utf8')));
}
function writeConfig(configPath, value) {
  validateConfig(value); ensureDirectory(path.dirname(configPath));
  return withLock(`${configPath}.lock`, () => { atomicWrite(configPath, value); return value; });
}
export function enableAdoption({ configPath = defaultAdoptionConfigPath(), answer, interactive = true, now = () => new Date(), env = process.env } = {}) {
  if (dnt(env)) return { ...readAdoptionConfig(configPath), enabled: false, exitCode: 1 };
  if (!interactive || !/^y(?:es)?$/i.test(String(answer ?? '').trim())) return { ...readAdoptionConfig(configPath), enabled: false };
  return writeConfig(configPath, { schema_version: ADOPTION_SCHEMA_VERSION, enabled: true, consent_state: 'enabled', consent_version: ADOPTION_CONSENT_VERSION, consented_at: now().toISOString() });
}

function emptyState() { return { schema_version: ADOPTION_SCHEMA_VERSION, identities: {}, last_emitted: {}, queue: [] }; }
function readState(statePath) {
  if (!fs.existsSync(statePath)) return emptyState();
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  if (!record(state) || state.schema_version !== ADOPTION_SCHEMA_VERSION || !record(state.identities) || !record(state.last_emitted ?? {}) || !Array.isArray(state.queue)) throw new Error('adoption state is invalid');
  state.last_emitted ??= {};
  return state;
}
function validRow(row) {
  if (!record(row) || row.event !== 'installation_activity' || row.schema_version !== 1 || row.consent_version !== 1
    || row.event !== 'installation_activity' || typeof row.installation_id !== 'string' || typeof row.day_utc !== 'string'
    || typeof row.plugin_version !== 'string' || !HOSTS.has(row.host) || typeof row._timeUnixNano !== 'string') throw new Error('adoption queue row is invalid');
  validateUuid(row.installation_id); validateVersion(row.plugin_version);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(row.day_utc) || !/^\d{19}$/.test(row._timeUnixNano)) throw new Error('adoption queue row is invalid');
  const date = new Date(Number(row._timeUnixNano.slice(0, 13)));
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== row.day_utc || date.getTime() > Date.now() + 5 * 60_000) throw new Error('adoption queue row is invalid');
  return row;
}
function dnt(env) { return env.DO_NOT_TRACK !== undefined && env.DO_NOT_TRACK !== '' && env.DO_NOT_TRACK !== '0'; }

export function recordAdoption({ env = process.env, configPath = defaultAdoptionConfigPath(env), statePath = defaultAdoptionStatePath(env), host, pluginVersion = PLUGIN_VERSION, observedAt = new Date() } = {}) {
  if (dnt(env) || !readAdoptionConfig(configPath).enabled) return false;
  validateHost(host); validateVersion(pluginVersion);
  const { day, nano } = dateParts(observedAt);
  if (Number(nano.slice(0, 13)) < Date.now() - 30 * 86_400_000) return false;
  ensureDirectory(path.dirname(statePath));
  return withLock(`${statePath}.lock`, () => {
    if (!readAdoptionConfig(configPath).enabled || dnt(env)) return false;
    const state = readState(statePath);
    const cutoff = Date.now() - 30 * 86_400_000;
    state.queue = state.queue.filter((row) => Number(row._timeUnixNano.slice(0, 13)) >= cutoff);
    const installation_id = state.identities[host] || randomUUID();
    validateUuid(installation_id);
    state.identities[host] = installation_id;
    const previous = state.last_emitted[host];
    const duplicate = previous?.day_utc === day && previous?.plugin_version === pluginVersion;
    if (duplicate) { atomicWrite(statePath, state); return false; }
    state.queue.push({ schema_version: 1, consent_version: 1, event: 'installation_activity', installation_id, day_utc: day, plugin_version: pluginVersion, host, _timeUnixNano: nano });
    state.last_emitted[host] = { day_utc: day, plugin_version: pluginVersion };
    state.queue.splice(0, Math.max(0, state.queue.length - MAX_QUEUE));
    atomicWrite(statePath, state);
    return true;
  });
}

export function disableAdoption({ configPath = defaultAdoptionConfigPath(), statePath = defaultAdoptionStatePath() } = {}) {
  return withLock(`${statePath}.lock`, () => {
    const result = writeConfig(configPath, { schema_version: ADOPTION_SCHEMA_VERSION, enabled: false, consent_state: 'declined' });
    fs.rmSync(statePath, { force: true });
    return result;
  });
}

function adoptionLogRecord(row) {
    validRow(row);
    return { timeUnixNano: row._timeUnixNano, body: { stringValue: 'sando.installation_activity' }, attributes: ['schema_version', 'consent_version', 'event', 'installation_id', 'day_utc', 'plugin_version', 'host'].map((key) => ({ key, value: { [key === 'schema_version' || key === 'consent_version' ? 'intValue' : 'stringValue']: row[key] } })) };
}
export function toAdoptionOtlp(rows) {
  return { resourceLogs: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 'sando-adoption' } }] }, scopeLogs: [{ scope: {}, logRecords: rows.map(adoptionLogRecord) }] }] };
}

function validateEndpoint(endpoint) {
  const url = new URL(endpoint);
  const production = `${url.protocol}//${url.host}${url.pathname}` === ADOPTION_ENDPOINT;
  const loopback = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && url.pathname === '/v1/logs' && !url.username && !url.password && !url.search && !url.hash;
  if ((!production && !loopback) || url.username || url.password || url.search || url.hash) throw new Error('adoption endpoint is invalid');
}
export async function flushAdoptionQueue({ configPath = defaultAdoptionConfigPath(), statePath = defaultAdoptionStatePath(), endpoint = ADOPTION_ENDPOINT, fetchImpl = fetch, env = process.env, timeoutMs = 3000, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const initialConfig = readAdoptionConfig(configPath);
  if (dnt(env) || !initialConfig.enabled || !fs.existsSync(statePath)) return { sent: 0 };
  const consentGeneration = initialConfig.consented_at;
  validateEndpoint(endpoint);
  let rows;
  withLock(`${statePath}.lock`, () => {
    const state = readState(statePath); const cutoff = Date.now() - 30 * 86_400_000;
    state.queue = state.queue.filter((row) => Number(row._timeUnixNano.slice(0, 13)) >= cutoff);
    rows = state.queue.slice(); atomicWrite(statePath, state);
  });
  if (!rows.length) return { sent: 0 };
  validRow(rows[0]);
  if (!readAdoptionConfig(configPath).enabled) return { sent: 0 };
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const currentConfig = readAdoptionConfig(configPath);
      if (dnt(env) || !currentConfig.enabled || currentConfig.consented_at !== consentGeneration) return { sent: 0 };
      try {
        response = await fetchImpl(endpoint, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify(toAdoptionOtlp(rows)), signal: controller.signal });
        if (response.ok) break;
      } catch (error) { if (attempt === 3) throw error; }
      if (attempt < 3) await sleep(100 * 2 ** (attempt - 1));
    }
  } finally { clearTimeout(timer); }
  if (!response?.ok) throw new Error(`adoption endpoint returned ${response?.status ?? 'failure'}`);
  let acknowledged = false;
  withLock(`${statePath}.lock`, () => {
    const currentConfig = readAdoptionConfig(configPath);
    if (!currentConfig.enabled || currentConfig.consented_at !== consentGeneration) return;
    const latest = readState(statePath); latest.queue = latest.queue.filter((row) => !rows.some((sent) => row.installation_id === sent.installation_id && row.day_utc === sent.day_utc && row.plugin_version === sent.plugin_version && row._timeUnixNano === sent._timeUnixNano)); atomicWrite(statePath, latest); acknowledged = true;
  });
  if (!acknowledged) return { sent: 0 };
  return { sent: rows.length };
}

export function scheduleAdoptionFlush({ env = process.env, configPath = defaultAdoptionConfigPath(env), statePath = defaultAdoptionStatePath(env), spawnImpl = spawn } = {}) {
  if (flushScheduled || dnt(env) || !readAdoptionConfig(configPath).enabled || !fs.existsSync(statePath)) return false;
  flushScheduled = true;
  try {
    const entry = fileURLToPath(new URL('./adoption-cli.mjs', import.meta.url));
    let scheduled = false;
    withLock(`${statePath}.lock`, () => {
      const state = readState(statePath); const now = Date.now();
      if (state.next_flush_at && state.next_flush_at > now) return;
      state.next_flush_at = now + 60_000; atomicWrite(statePath, state); scheduled = true;
    });
    if (!scheduled) return false;
    const child = spawnImpl(process.execPath, [entry, 'flush'], { detached: true, stdio: 'ignore', env: { ...env, XDG_CONFIG_HOME: path.dirname(path.dirname(configPath)), XDG_STATE_HOME: path.dirname(path.dirname(statePath)) } });
    child.unref();
    return true;
  } catch { return false; } finally { flushScheduled = false; }
}
