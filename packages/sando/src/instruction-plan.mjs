import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { createRedactionProfile } from './redaction-profile.mjs';

export const INSTRUCTION_CAPTURE_SCHEMA = 'sando-instruction-capture/v1';
export const INSTRUCTION_PLAN_SCHEMA = 'sando-instruction-plan/v1';
export const INSTRUCTION_PLAN_VERSION = 1;
export const INSTRUCTION_CLASSIFICATIONS = Object.freeze(['always-on', 'on-demand', 'duplicate', 'unknown']);

const HOSTS = new Set(['claude', 'codex', 'both']);
const INSTRUCTION_NAMES = new Set(['AGENTS.md', 'CLAUDE.md']);
const SKILL_LAYOUTS = Object.freeze({
  claude: '.claude/skills',
  codex: '.agents/skills',
});
const SKIP_DIRECTORIES = new Set(['.git', 'node_modules']);
const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILES = 512;
const DEFAULT_PROFILE = createRedactionProfile();

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeCounter(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function add(left, right, name) {
  const total = left + right;
  if (!safeCounter(total)) throw new RangeError(`${name} exceeds safe integer range`);
  return total;
}

function estimateBytes(bytes) {
  return bytes === 0 ? 0 : Math.ceil(bytes / 4);
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function stableJson(value, seen = new Set()) {
  if (value === null || typeof value !== 'object') {
    const result = JSON.stringify(value);
    if (result === undefined) throw new TypeError('value is not JSON serializable');
    return result;
  }
  if (seen.has(value)) throw new TypeError('value must not be cyclic');
  seen.add(value);
  const result = Array.isArray(value)
    ? `[${value.map((item) => stableJson(item, seen)).join(',')}]`
    : `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key], seen)}`).join(',')}}`;
  seen.delete(value);
  return result;
}

function relativePath(root, target) {
  const relative = path.relative(root, target);
  return relative.split(path.sep).join('/') || '.';
}

function insideRoot(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function readText(root, relative) {
  const target = path.resolve(root, relative);
  if (!insideRoot(root, target)) throw new Error('instruction path escapes root');
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('instruction source is not a regular file');
  if (stat.size > MAX_FILE_BYTES) throw new Error('instruction source exceeds 512 KiB');
  const buffer = fs.readFileSync(target);
  if (buffer.length > MAX_FILE_BYTES) throw new Error('instruction source exceeds 512 KiB');
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch (error) {
    throw new Error('instruction source is not valid UTF-8', { cause: error });
  }
  return { text, bytes: buffer.length };
}

function walk(root) {
  const instructions = [];
  const skills = [];
  function visit(directory) {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => !entry.isSymbolicLink())
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name)) visit(path.join(directory, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      const target = path.join(directory, entry.name);
      const relative = relativePath(root, target);
      if (INSTRUCTION_NAMES.has(entry.name)) instructions.push(relative);
      const parts = relative.split('/');
      if (entry.name === 'SKILL.md' && (parts.includes('.claude') || parts.includes('.agents'))
        && parts.includes('skills')) skills.push(relative);
    }
  }
  visit(root);
  return { instructions: [...new Set(instructions)].sort(), skills: [...new Set(skills)].sort() };
}

function importLine(line) {
  const match = line.match(/^\s*@([^\s]+)\s*$/);
  return match?.[1] ?? null;
}

function parseBlocks(text) {
  const lines = text.split(/\r?\n/);
  const blocks = [];
  let start = null;
  const flush = (end) => {
    if (start === null) return;
    const content = lines.slice(start - 1, end).join('\n').trim();
    if (content) blocks.push({ startLine: start, endLine: end, text: content });
    start = null;
  };
  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    if (!line.trim() || importLine(line)) {
      flush(lineNumber - 1);
      return;
    }
    if (start === null) start = lineNumber;
  });
  flush(lines.length);
  return blocks;
}

function normalizeBlock(text) {
  return text.toLowerCase()
    .replace(/[`*_>#-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function directive(text) {
  const normalized = text.replace(/^#+\s*/gm, '').replace(/\s+/g, ' ').trim();
  const match = normalized.match(/^(always|never|must not|do not|don't|prefer|avoid|use|should|may)\s+(.+)$/i);
  if (!match) return null;
  const polarity = /^(never|must not|do not|don't|avoid)$/i.test(match[1]) ? 'negative' : 'positive';
  return { key: normalizeBlock(match[2]), polarity };
}

function safetyCritical(text) {
  return /\b(?:security|safety|secret|credential|password|private key|api key|authorization|permission|approval|sandbox|fail[- ]closed|invariant|scope|do not|don't|never|must not|ask (?:the )?user|confirm(?:ation)?|without (?:explicit )?confirmation|no (?:push|publish|deploy|delete)|destructive|delet(?:e|es|ed|ing|ion)|production|dry[- ]run|rollback)\b/i.test(text);
}

function onDemand(text) {
  return /\b(?:when|for|workflow|procedure|run|test|testing|build|release|deploy|debug|inspect|command|commands|check|validation|package|npm|node|git|documentation|readme)\b/i.test(text);
}

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'project-procedure';
}

function skillName(block) {
  const text = block.text.toLowerCase();
  if (/\b(?:test|testing|npm test|node --test)\b/.test(text)) return 'testing';
  if (/\b(?:release|deploy|publish)\b/.test(text)) return 'release-operations';
  if (/\b(?:documentation|readme)\b/.test(text)) return 'documentation';
  return slugify(block.source.path.split('/').pop().replace(/\.(?:md|markdown)$/i, ''));
}

function destinationFor(block, hosts, skillPaths) {
  const name = skillName(block);
  const hostPaths = Object.fromEntries(hosts.map((host) => [host, `${SKILL_LAYOUTS[host]}/${name}/SKILL.md`]));
  const existingPaths = skillPaths.filter((candidate) => hosts.some((host) => candidate === hostPaths[host]));
  return { type: 'portable-skill', name, shared: true, hostPaths, existingPaths };
}

function resolveImport(root, sourcePath, target) {
  const sourceAbsolute = path.resolve(root, sourcePath);
  const targetAbsolute = path.resolve(path.dirname(sourceAbsolute), target);
  if (!insideRoot(root, targetAbsolute)) return { status: 'external', target: '[external]' };
  const relative = relativePath(root, targetAbsolute);
  try {
    const stat = fs.lstatSync(targetAbsolute);
    if (stat.isSymbolicLink() || !stat.isFile()) return { status: 'unresolved', target: relative };
    return { status: 'resolved', target: relative };
  } catch (error) {
    if (error?.code === 'ENOENT') return { status: 'unresolved', target: relative };
    throw error;
  }
}

function classify(blocks) {
  const firstByText = new Map();
  const directives = new Map();
  for (const block of blocks) {
    block.normalized = normalizeBlock(block.text);
    block.directive = directive(block.text);
    if (block.directive) {
      const group = directives.get(block.directive.key) ?? [];
      group.push(block);
      directives.set(block.directive.key, group);
    }
  }
  for (const group of directives.values()) {
    const polarities = new Set(group.map((block) => block.directive.polarity));
    if (polarities.size < 2) continue;
    for (const block of group) block.conflictWith = group.filter((candidate) => candidate !== block).map((candidate) => candidate.id);
  }
  for (const block of blocks) {
    const duplicateOf = firstByText.get(block.normalized);
    if (duplicateOf) block.duplicateOf = duplicateOf.id;
    else firstByText.set(block.normalized, block);
    if (safetyCritical(block.text)) block.classification = 'always-on';
    else if (block.conflictWith?.length) block.classification = 'unknown';
    else if (block.duplicateOf) block.classification = 'duplicate';
    else if (onDemand(block.text)) block.classification = 'on-demand';
    else block.classification = 'unknown';
    block.reason = {
      'always-on': 'contains a safety, authorization, or scope invariant',
      'on-demand': 'contains a recognizable procedure or task-specific workflow',
      duplicate: `normalized text duplicates ${block.duplicateOf}`,
      unknown: block.conflictWith?.length ? 'conflicting directive requires manual review' : 'ambiguous block has no safe deterministic move',
    }[block.classification];
  }
}

function safeBlock(block, profile) {
  const bytes = Buffer.byteLength(block.text, 'utf8');
  const reviewText = profile.redact(block.text).text;
  return {
    id: block.id,
    source: block.source,
    classification: block.classification,
    bytes,
    estimatedTokens: estimateBytes(bytes),
    digest: sha256(reviewText),
    reason: block.reason,
    ...(block.duplicateOf ? { duplicateOf: block.duplicateOf } : {}),
    ...(block.conflictWith?.length ? { conflictWith: block.conflictWith } : {}),
  };
}

function safeReport(report) {
  const result = { ...report };
  delete result.provenanceDigest;
  return result;
}

export function serializeInstructionPlan(report) {
  if (!object(report) || report.schema !== INSTRUCTION_PLAN_SCHEMA) throw new TypeError('instruction plan is invalid');
  return stableJson(report);
}

export function buildInstructionPlan({ root, host = 'both' } = {}) {
  if (typeof root !== 'string' || !root) throw new TypeError('instruction root is invalid');
  if (!HOSTS.has(host)) throw new TypeError('instruction host is invalid');
  const absoluteRoot = fs.realpathSync(root);
  if (!fs.statSync(absoluteRoot).isDirectory()) throw new TypeError('instruction root is not a directory');
  const profile = DEFAULT_PROFILE;
  const selectedHosts = host === 'both' ? ['claude', 'codex'] : [host];
  const discovered = walk(absoluteRoot);
  discovered.instructions = discovered.instructions.filter((sourcePath) => {
    const name = path.basename(sourcePath);
    return host === 'both' || (host === 'claude' ? name === 'CLAUDE.md' : name === 'AGENTS.md');
  });
  if (discovered.instructions.length > MAX_FILES) throw new Error('too many instruction files');
  const queue = [...discovered.instructions];
  const loaded = new Set();
  const files = [];
  const imports = [];
  const blocks = [];
  while (queue.length) {
    const sourcePath = queue.shift();
    if (loaded.has(sourcePath)) continue;
    loaded.add(sourcePath);
    const source = readText(absoluteRoot, sourcePath);
    const fileBlockIds = [];
    const lines = source.text.split(/\r?\n/);
    lines.forEach((line, index) => {
      const target = importLine(line);
      if (!target) return;
      const resolved = resolveImport(absoluteRoot, sourcePath, target);
      const item = { source: { path: sourcePath, line: index + 1 }, ...resolved };
      imports.push(item);
      if (resolved.status === 'resolved' && !loaded.has(resolved.target)) queue.push(resolved.target);
    });
    for (const parsed of parseBlocks(source.text)) {
      const block = {
        ...parsed,
        id: `block-${blocks.length + 1}`,
        source: { path: sourcePath, startLine: parsed.startLine, endLine: parsed.endLine },
      };
      blocks.push(block);
      fileBlockIds.push(block.id);
    }
    files.push({
      path: sourcePath,
      kind: discovered.instructions.includes(sourcePath) ? 'instruction' : 'import',
      bytes: source.bytes,
      estimatedTokens: estimateBytes(source.bytes),
      digest: sha256(profile.redact(source.text).text),
      blocks: fileBlockIds,
    });
    if (files.length > MAX_FILES) throw new Error('too many instruction files');
  }
  classify(blocks);
  const skillPaths = discovered.skills;
  const safeBlocks = blocks.map((block) => safeBlock(block, profile));
  const proposals = safeBlocks.filter((block) => block.classification === 'on-demand').map((block) => {
    const destination = destinationFor(blocks.find((candidate) => candidate.id === block.id), selectedHosts, skillPaths);
    const preview = {
      bytes: block.bytes,
      estimatedTokens: block.estimatedTokens,
      digest: block.digest,
    };
    return {
      id: `proposal-${block.id.slice('block-'.length)}`,
      blockId: block.id,
      classification: block.classification,
      source: block.source,
      destination,
      reason: 'move this task-specific block behind an on-demand portable skill',
      estimatedFootprintAvoided: { bytes: block.bytes, estimatedTokens: block.estimatedTokens },
      diff: {
        operation: 'move-preview',
        remove: {
          path: block.source.path, startLine: block.source.startLine, endLine: block.source.endLine,
          bytes: block.bytes, preview,
        },
        add: {
          hostPaths: destination.hostPaths, existingPaths: destination.existingPaths,
          mode: destination.existingPaths.length ? 'reuse-existing' : 'create-on-apply',
          preview,
        },
      },
    };
  });
  const summary = {
    alwaysOnBlocks: safeBlocks.filter((block) => block.classification === 'always-on').length,
    onDemandBlocks: safeBlocks.filter((block) => block.classification === 'on-demand').length,
    duplicateBlocks: safeBlocks.filter((block) => block.classification === 'duplicate').length,
    unknownBlocks: safeBlocks.filter((block) => block.classification === 'unknown').length,
  };
  const bytesFor = (classification) => safeBlocks.filter((block) => block.classification === classification)
    .reduce((total, block) => add(total, block.bytes, `${classification} bytes`), 0);
  const report = {
    schema: INSTRUCTION_PLAN_SCHEMA,
    version: INSTRUCTION_PLAN_VERSION,
    host,
    files,
    imports,
    blocks: safeBlocks,
    proposals,
    summary: {
      ...summary,
      instructionBytes: safeBlocks.reduce((total, block) => add(total, block.bytes, 'instruction bytes'), 0),
      alwaysOnBytes: bytesFor('always-on'),
      onDemandBytes: bytesFor('on-demand'),
      duplicateBytes: bytesFor('duplicate'),
      unknownBytes: bytesFor('unknown'),
      proposedBytes: proposals.reduce((total, proposal) => add(total, proposal.estimatedFootprintAvoided.bytes, 'proposed bytes'), 0),
    },
  };
  report.provenanceDigest = sha256(serializeInstructionPlan(safeReport(report)));
  return report;
}
