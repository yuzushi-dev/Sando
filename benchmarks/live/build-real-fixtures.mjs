#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';

function redact(text) {
  let count = 0;
  const replace = (pattern, replacement) => {
    text = text.replace(pattern, (...args) => {
      count += 1;
      return typeof replacement === 'function' ? replacement(...args) : replacement;
    });
  };
  replace(/-----BEGIN [A-Z ]+ KEY-----[\s\S]*?-----END [A-Z ]+ KEY-----/g, '[REDACTED PRIVATE KEY]');
  replace(/\b(?:sk|rk|gh[pousr])-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED TOKEN]');
  replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED TOKEN]');
  replace(/(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s,"'}]+/gi, (_match, prefix) => `${prefix}[REDACTED]`);
  replace(/(["']?(?:api[_-]?key|access[_-]?token|password|secret|private[_-]?key)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, (_match, prefix) => `${prefix}[REDACTED]`);
  return { text, count };
}

function toolPath(name, input) {
  if (!input || typeof input !== 'object') return undefined;
  if (typeof input.file_path === 'string') return input.file_path;
  if (typeof input.command === 'string') return input.command;
  if (typeof input.pattern === 'string') return input.pattern;
  if (typeof input.path === 'string') return input.path;
  if (typeof input.url === 'string') return input.url;
  if (typeof input.query === 'string') return input.query;
  return undefined;
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text).join('');
  }
  return '';
}

function pickFact(lines, startIdx, direction) {
  let idx = startIdx;
  for (let attempt = 0; attempt < 3 && idx >= 0 && idx < lines.length; attempt += 1) {
    const trimmed = lines[idx].trim();
    if (trimmed.length >= 8) return trimmed.slice(0, 200);
    idx += direction;
  }
  return undefined;
}

function requiredFacts(text) {
  const lines = text.split('\n');
  const nonEmpty = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim().length > 0) nonEmpty.push(i);
  }
  if (nonEmpty.length === 0) return [];
  const head = pickFact(lines, nonEmpty[0], 1);
  const tail = pickFact(lines, nonEmpty[nonEmpty.length - 1], -1);
  const facts = [];
  if (head !== undefined) facts.push(head);
  if (tail !== undefined && tail !== head) facts.push(tail);
  return facts;
}

async function extract(sourcePath) {
  const toolUses = new Map();
  const candidates = [];
  let redactionCount = 0;
  let errorCount = 0;

  const rl = readline.createInterface({
    input: fs.createReadStream(sourcePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }

    if (record.type === 'assistant') {
      const content = record.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === 'tool_use' && typeof block.id === 'string') {
            toolUses.set(block.id, { toolName: block.name, path: toolPath(block.name, block.input) });
          }
        }
      }
    } else if (record.type === 'user') {
      const content = record.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
          const use = toolUses.get(block.tool_use_id);
          if (!use) continue;
          if (block.is_error) errorCount += 1;
          const text = resultText(block.content);
          if (text.length < 4000) continue;
          candidates.push({ toolName: use.toolName, path: use.path, text });
        }
      }
    }
  }

  candidates.sort((a, b) => b.text.length - a.text.length);

  const seen = new Set();
  const selected = [];
  for (const candidate of candidates) {
    if (selected.length >= 6) break;
    if (seen.has(candidate.text)) continue;
    seen.add(candidate.text);
    selected.push(candidate);
  }

  const events = selected.map((candidate, i) => {
    const { text: redacted, count } = redact(candidate.text);
    redactionCount += count;
    const event = {
      id: `real-${i + 1}`,
      toolName: candidate.toolName,
      output: redacted,
    };
    if (candidate.path !== undefined) event.path = candidate.path;
    const facts = requiredFacts(redacted);
    if (facts.length > 0) event.requiredFacts = facts;
    return event;
  });

  return { events, redactionCount, errorCount };
}

function parseArgs(argv) {
  let source;
  let out;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--source') source = argv[++i];
    else if (argv[i] === '--out') out = argv[++i];
  }
  if (!source || !out) {
    throw new Error('usage: build-real-fixtures.mjs --source <jsonl> --out <json>');
  }
  return { source, out };
}

async function main() {
  const { source, out } = parseArgs(process.argv.slice(2));
  const { events, redactionCount, errorCount } = await extract(source);
  const id = out.replace(/^.*\//, '').replace(/\.json$/, '');
  const scenario = {
    id,
    description: `Real transcript extract from ${source.replace(/^.*\//, '')}`,
    events,
  };
  fs.writeFileSync(out, JSON.stringify(scenario, null, 2));

  const lengths = events.map((e) => e.output.length);
  const tools = [...new Set(events.map((e) => e.toolName))];
  console.log(JSON.stringify({
    source: source.replace(/^.*\//, ''),
    out,
    eventCount: events.length,
    minLength: lengths.length ? Math.min(...lengths) : 0,
    maxLength: lengths.length ? Math.max(...lengths) : 0,
    redactionCount,
    toolErrorCount: errorCount,
    tools,
  }));
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
