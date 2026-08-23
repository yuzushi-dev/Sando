# Sando scaffold

Sando is a dependency-free Node 22 layer for deterministic tool-output preparation and A/B harnesses. It does not claim provider savings, invoke an LLM, or access the network.

## Data flow

1. A benchmark, hook, or MCP caller supplies `toolName`, `output`, `cwd`, and optional policy.
2. The core canonicalizes JSON output, redacts common credential forms, and measures UTF-8 bytes.
3. Small output stays inline. Larger output keeps a complete redacted artifact and a bounded inline head/tail view with middle elision and column caps.
4. Exact byte stats, approximate `bytes / 4` token counts, and content digests form a deterministic receipt.
5. Hooks persist redacted numeric metrics records atomically; provider-token accounting is recorded separately only when paired provider counters are supplied.

The stable benchmark entry point is `packages/sando/index.mjs`:

```js
import { estimateTokens, optimizeToolOutput } from '../packages/sando/index.mjs';
```

See `packages/sando/README.md` for the exact API and policy.

## MCP stdio protocol

Transport is one JSON-RPC 2.0 object per UTF-8 line on stdin/stdout. Supported requests are `initialize`, `ping`, `tools/list`, and `tools/call`. Notifications receive no response. There is one tool:

- `prepare_tool_output`: read-only, idempotent, closed-world; accepts the core API arguments and returns the core result in `structuredContent`, with `inline` duplicated as MCP text content.

The server performs no filesystem writes or network operations. Invalid tool arguments return an MCP tool error. Invalid JSON-RPC returns standard parse/request/method errors.

## Host support

- Codex: the required manifest and companion `.mcp.json` are in `plugins/sando`; `hooks/hooks.json` has no manifest `hooks` field. The default hook surface is observational. Opt-in `SANDO_CODEX_FALLBACK=feedback` returns documented `continue:false` feedback and explicitly does not rewrite the delivered result.
- Claude Code: `.claude-plugin/plugin.json`, `hooks/hooks.json`, and `.mcp.json` are under `adapters/claude/sando`. `apply` emits `hookSpecificOutput.updatedToolOutput` for string results and Bash-shaped results while preserving the structured keys. Oversized redacted artifacts are persisted under `cwd/.sando/sando/artifacts`. `observe` and `dry-run` remain observational.
- Direct Codex adapter: `adapters/codex/sando` is a standalone copied/cacheable launcher bundle with its own runtime.

Codex hooks are not advertised as rewriting already-delivered tool output. Claude `apply` uses its replacement contract. The MCP and core paths transform explicitly on both hosts. Every bundle is tested after copying without `packages/`.

## User-visible metrics

Every standalone bundle includes `metrics.mjs`. It prints a human report by
default and `sando-report/v1` JSON with `--json`.

The report exposes current-session, average-per-session, cumulative, daily,
ISO-week, and monthly aggregates. Transform savings are estimated token units
from the deterministic UTF-8-byte estimate and are labeled
`estimatedTransformSavingsTokens`; they are not provider usage. Provider
savings remain `null` unless paired provider input counters are present.
Event IDs deduplicate retries; otherwise the receipt digest is the idempotency
key. No raw tool output is stored. The metrics file is under
`$XDG_STATE_HOME/sando/metrics.json` (fallback
`~/.local/state/sando/metrics.json`) or the absolute
`SANDO_METRICS_PATH` override. Its timezone is fixed on first creation;
daily/monthly boundaries use that local timezone and weekly boundaries are
ISO Monday-Sunday.

## Local validation

```sh
node --test packages/sando/tests/*.test.mjs
npm test
node --check packages/sando/src/core.mjs
node --check packages/sando/src/hook-cli.mjs
node --check packages/sando/src/mcp-server.mjs
node packages/sando/src/metrics-cli.mjs --json
```

Production gaps: host-version compatibility probes, durable artifact retention policy, broader secret classifiers, provider-native tokenizer comparison, and reproducible live A/B data. Provider-native compaction, semantic pruning, prompt caching, and response chaining remain separate integrations to design and verify.
