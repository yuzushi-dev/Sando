import { execFileSync } from 'node:child_process';

function command(args) {
  try {
    return execFileSync('codex', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

export function detectCodexHost() {
  return {
    version: command(['--version']).trim(),
    help: command(['--help']),
    mcpHelp: command(['mcp', '--help']),
    features: command(['features', 'list']),
  };
}

export function probeCodexCapabilities(observed = detectCodexHost()) {
  const hooksAvailable = /\bhooks\s+stable\s+true\b/i.test(observed.features);
  const mcpAvailable = /\bmcp\b/i.test(observed.help) && /MCP/i.test(observed.mcpHelp);
  return {
    schema: 'sando-codex-capabilities/v1',
    host: 'codex',
    version: observed.version || null,
    mcp: { available: mcpAvailable, additiveOnly: true, displacesBuiltIns: false },
    preToolUse: { available: hooksAvailable, canRewriteInput: hooksAvailable, canRewriteToolOutput: false },
    postToolUse: { available: hooksAvailable, observational: true, feedbackFallback: hooksAvailable, canRewriteToolOutput: false },
    preModelToolOutputReplacement: false,
    wrapperMcpTools: { Read: 'impossible', Grep: 'impossible', Bash: 'impossible' },
    providerSavings: false,
    status: 'impossible',
    reason: 'Codex exposes MCP as additional model-callable tools and has no supported path that displaces a built-in result before model context construction.',
  };
}
