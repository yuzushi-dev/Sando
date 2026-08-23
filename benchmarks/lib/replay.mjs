import fs from 'node:fs/promises';

export async function loadScenario(source) {
  const text = typeof source === 'string' || source instanceof URL
    ? await fs.readFile(source, 'utf8')
    : JSON.stringify(source);
  const scenario = JSON.parse(text);
  if (!scenario || typeof scenario.id !== 'string' || !Array.isArray(scenario.events)
    || scenario.events.length === 0) throw new TypeError('invalid benchmark scenario');
  const ids = new Set();
  const events = [];
  for (const event of scenario.events) {
    const output = typeof event?.output === 'string' ? event.output
      : event?.output && typeof event.output.repeat === 'string'
        && Number.isInteger(event.output.count) && event.output.count > 0
        && event.output.count <= 10000
        && (event.output.prefix === undefined || typeof event.output.prefix === 'string')
        && (event.output.suffix === undefined || typeof event.output.suffix === 'string')
        ? `${event.output.prefix ?? ''}${event.output.repeat.repeat(event.output.count)}${event.output.suffix ?? ''}`
        : null;
    if (!event || typeof event.id !== 'string' || ids.has(event.id)
      || typeof event.toolName !== 'string' || output === null) {
      throw new TypeError('invalid benchmark event');
    }
    ids.add(event.id);
    events.push({ ...event, output });
  }
  return { ...scenario, events };
}

export async function replayScenario(scenario, transform) {
  if (!scenario || typeof transform !== 'function') throw new TypeError('scenario and transform are required');
  const receipts = [];
  for (const event of scenario.events) {
    const result = await transform(event);
    if (!result || typeof result !== 'object' || typeof result.inline !== 'string') {
      throw new TypeError(`transform returned no inline output for ${event.id}`);
    }
    receipts.push({
      event: event.id,
      inline: result.inline,
      artifact: result.artifact ?? null,
      stats: result.stats ?? {},
    });
  }
  return { scenario: scenario.id, receipts };
}
