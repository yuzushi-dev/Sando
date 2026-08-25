# Sando for Claude Code

Repo-local or copied/cache Claude Code plugin bundle.

## Install

```sh
claude --plugin-dir "$PWD/adapters/claude/sando"
```

The `PostToolUse` hook applies preparation by default for string results and Bash-shaped objects with string `stdout` and `stderr` fields. Set `SANDO_MODE=observe` to record receipts and metrics without replacing the result. Optional `interrupted` and `isImage` fields must be booleans; other structured result shapes remain unchanged. `SANDO_MODE=dry-run` prepares and records a candidate without replacing the result.

The applied path now performs the OMP-compatible reductions that are safe at Claude's `PostToolUse` boundary: structural summaries for large unselected `Read` results, bounded `Grep` output, repeated-line collapse for Bash output, redaction, and artifact-backed recovery. Explicit read selectors and raw reads remain unchanged.

For real-session observation, force the safety boundary even if another environment variable or policy requests `apply`:

```sh
SANDO_OBSERVE_ONLY=1 claude --plugin-dir "$PWD/adapters/claude/sando"
```

`SANDO_OBSERVE_ONLY` accepts `1`, `true`, or `yes`; it overrides the policy mode, keeps the original tool result untouched, and still records local candidate estimates.

When replacement produces an artifact reference, the adapter writes the complete redacted artifact atomically under `cwd/.sando/sando/artifacts` with private file permissions. The core itself does not write artifacts.

The bundle also exposes the read-only, network-free `prepare_tool_output` MCP tool. Malformed events, persistence failures, and telemetry failures are fail-open. Invalid `SANDO_POLICY` exits with status `2`.

The `Stop` hook reads `transcript_path`, keeps only numeric `message.usage` counters, and appends them idempotently to `~/.local/state/sando/provider-usage.json`. It never stores transcript text. The statusline wrapper at [`statusline.mjs`](statusline.mjs) preserves any existing statusline output and appends the current Claude session's compact Sando savings plus an input-cost estimate when the selected model is recognized; provider usage counters remain in the ledger.

## Metrics

```sh
node adapters/claude/sando/metrics.mjs
node adapters/claude/sando/metrics.mjs --json
```

The report uses `sando-report/v1` and separates local transform estimates from provider-reported savings. With RTK or another `PostToolUse` transformer active, estimates are measured at Sando's hook boundary and must not be added to the other plugin's percentage. See [`packages/sando/README.md`](../../../packages/sando/README.md) for the core API.

The bundle includes `bin/sando-statusline`, which resolves the installed plugin root itself. Set Claude's command-backed `statusLine` to `sando-statusline` and set `SANDO_WRAPPED_STATUSLINE` to the existing statusline command when another badge should be preserved.

Run the adapter-boundary probe with its captured PostToolUse fixture:

```sh
node adapters/claude/sando/tests/e2e-probe.mjs
```

It verifies replacement, artifact resolution, and receipt alignment without making a Claude or provider request.

## Optional provider proxy

For history-level pruning, run Sando as a loopback provider gateway. This is separate from the `PostToolUse` hook:

```sh
SANDO_UPSTREAM_URL=https://api.anthropic.com SANDO_PROXY_PORT=8787 npm run proxy
ANTHROPIC_BASE_URL=http://127.0.0.1:8787 claude --plugin-dir "$PWD/adapters/claude/sando"
```

The proxy applies deterministic repeated-Read pruning, exact historical result deduplication, repeated-line compaction for Bash/log output, and extractive shaking of large historical Bash/Grep/log results before the Anthropic Messages request. Set `SANDO_CONTEXT_POLICY='{"maxHistoryTokens":120000}'` to gate the additional reductions at 80% of the request budget. Shake preserves head/tail/high-signal lines rather than generating a semantic summary. It passes streaming responses through unchanged, makes no LLM calls, and does not log credentials. This reduces model input context; it does not remove raw content already rendered by the host transcript.
