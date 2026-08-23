# Sando

Sando is a dependency-free Node 22 layer for deterministic tool-output preparation across Claude Code and Codex. It bounds inline output, keeps a redacted artifact when needed, emits receipts, and records local metrics.

> Status: early scaffold. Claude `PostToolUse` can replace tool output in `apply` mode. Codex hooks are observational. Local benchmarks report estimates; this checkout contains no provider-token savings result.

## Quick start

Requires Node `22.22.x`.

```sh
npm test
npm run check
npm run benchmark:local -- --scenario terminal-noise --repetitions 1 --out /tmp/sando-local.json
```

Sando has no runtime dependencies, and its package manifests are private. This repository does not define a published package or installation target.

To run the core directly:

```js
import { optimizeToolOutput } from './packages/sando/index.mjs';

const output = '{"status":"ok"}';
const result = optimizeToolOutput({
  toolName: 'Read',
  output,
  cwd: process.cwd(),
  policy: { mode: 'apply', maxInlineBytes: 4096, redact: true },
});

console.log(result.inline);
```

The core does not call an LLM, use the network, or write files. For large output, Sando emits a bounded inline head/tail view and a content-addressed redacted artifact payload. `createReceipt` records digests and numeric stats without storing raw output.

## What the numbers mean

Sando reports two different signals:

| Field | Source | Meaning |
| --- | --- | --- |
| `estimatedTransformSavingsTokens` | Local UTF-8 byte estimate | `ceil(input bytes / 4) - ceil(inline bytes / 4)` for the deterministic transform. |
| `providerReportedSavingsTokens` | Paired provider counters | Present only when an event supplies baseline and optimized input counters. Otherwise it is `null`. |

The local benchmark never observes a provider prompt or usage counter. Its estimate is not billing data and does not prove provider-token savings. Metrics use `sando-report/v1`, keep redacted numeric records, deduplicate event IDs, and aggregate current session, per-session average, cumulative, daily, ISO-week, and monthly values.

The default metrics file is `$XDG_STATE_HOME/sando/metrics.json`, falling back to `~/.local/state/sando/metrics.json`. Set `SANDO_METRICS_PATH` to an absolute path to override it.

```sh
node packages/sando/src/metrics-cli.mjs
node packages/sando/src/metrics-cli.mjs --json
```

## Claude Code

Load the repo-local Claude plugin from `adapters/claude/sando`:

```sh
claude --plugin-dir "$PWD/adapters/claude/sando"
```

The hook defaults to `SANDO_MODE=observe`. With `SANDO_MODE=apply`, it emits `hookSpecificOutput.updatedToolOutput` for string results and Bash-shaped `{stdout, stderr, ...}` results. The hook writes oversized redacted artifacts under `cwd/.sando/sando/artifacts` with restrictive permissions. `dry-run` remains observational.

Malformed events, persistence failures, and telemetry failures fail open. Invalid `SANDO_POLICY` exits with status `2`. The plugin does not change user configuration or a marketplace. See [`adapters/claude/sando/README.md`](adapters/claude/sando/README.md).

## Codex

The Codex plugin bundle lives in `plugins/sando`; the standalone adapter lives in `adapters/codex/sando`. The `PostToolUse` hook defaults to observation and returns `{}`. Codex exposes no portable replacement contract for an already-delivered tool result. The hook stays observational and makes no transparent-rewrite claim.

The explicit fallback stops the turn and returns feedback. It does not rewrite the tool result:

```sh
printf '%s\n' '{"hook_event_name":"PostToolUse","tool_name":"Read","tool_response":"hello","cwd":"/tmp"}' \
  | env SANDO_POLICY='{"mode":"apply"}' SANDO_CODEX_FALLBACK=feedback \
  node plugins/sando/hooks/post-tool-use.mjs
```

For effective preparation, use the read-only MCP tool `prepare_tool_output` or the core API. The bundled Codex MCP server uses JSON-RPC 2.0 over stdio and performs no writes or network access. See [`plugins/sando/README.md`](plugins/sando/README.md) and [`adapters/codex/sando/README.md`](adapters/codex/sando/README.md).

## Benchmarks

The local harness replays the same fixtures through a raw baseline and the optimizer. It measures the byte-based token estimate, artifact resolvability, model-visible facts, quality, and secret leaks. Reports include prompt digests and audit metadata.

```sh
npm run benchmark:local -- --scenario terminal-noise --repetitions 5
```

The live harness is a separate, quota-bearing operation. It requires `--confirm-cost`; Claude also requires `--max-budget-usd`.

```sh
npm run benchmark:live -- \
  --host claude \
  --model sonnet \
  --max-budget-usd 0.25 \
  --claude-plugin-dir adapters/claude/sando \
  --confirm-cost
```

Live runs compare prepared prompts at the provider CLI and record reported usage when available. They disable tool calls, so even with `--claude-plugin-dir` they remain prompt-level A/B measurements, not end-to-end `PostToolUse` measurements. Codex live runs are prompt-level as well. The test suite skips live runs.

See [`benchmarks/README.md`](benchmarks/README.md) for report fields and host-specific accounting.

## Experiments and limits

- `spikes/routing/` contains a routing plan for large reads, bounded grep matches, and high-volume Bash output. It is a tested design spike, not a host integration.
- `spikes/status-bar/claude-statusline.mjs` is a Claude status-line prototype. It marks estimates with `~`, marks provider-reported values without it, and shows stale data as stale. The sample refreshes every five seconds.
- Codex status-line configuration currently accepts built-in item identifiers only; the sample in [`spikes/status-bar/codex-config.example.toml`](spikes/status-bar/codex-config.example.toml) cannot add Sando as a custom item.
- The project still lacks provider-native tokenization, transparent Codex rewriting, semantic compaction, prompt caching, response chaining, host-version probes, and durable artifact retention.

## Development

```sh
npm test
npm run check
```

The repository layout is:

```text
packages/sando/             core API, metrics, MCP server, and tests
plugins/sando/              standalone Codex plugin bundle
adapters/claude/sando/      Claude Code bundle
adapters/codex/sando/       standalone Codex adapter bundle
benchmarks/                 local replay and gated live harnesses
spikes/                     routing and status-line experiments
```

The core API details live in [`packages/sando/README.md`](packages/sando/README.md). The scaffold notes are in [`docs/sando-scaffold.md`](docs/sando-scaffold.md).
