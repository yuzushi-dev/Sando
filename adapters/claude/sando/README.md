# Sando for Claude Code

Repo-local or copied/cache Claude Code plugin bundle.

## Install

```sh
claude --plugin-dir "$PWD/adapters/claude/sando"
```

The `PostToolUse` hook applies preparation by default for string results and Bash-shaped objects with string `stdout` and `stderr` fields. Set `SANDO_MODE=observe` to record receipts and metrics without replacing the result. Optional `interrupted` and `isImage` fields must be booleans; other structured result shapes remain unchanged. `SANDO_MODE=dry-run` prepares and records a candidate without replacing the result.

For real-session observation, force the safety boundary even if another environment variable or policy requests `apply`:

```sh
SANDO_OBSERVE_ONLY=1 claude --plugin-dir "$PWD/adapters/claude/sando"
```

`SANDO_OBSERVE_ONLY` accepts `1`, `true`, or `yes`; it overrides the policy mode, keeps the original tool result untouched, and still records local candidate estimates.

When replacement produces an artifact reference, the adapter writes the complete redacted artifact atomically under `cwd/.sando/sando/artifacts` with private file permissions. The core itself does not write artifacts.

The bundle also exposes the read-only, network-free `prepare_tool_output` MCP tool. Malformed events, persistence failures, and telemetry failures are fail-open. Invalid `SANDO_POLICY` exits with status `2`.

The `Stop` hook reads `transcript_path`, keeps only numeric `message.usage` counters, and appends them idempotently to `~/.local/state/sando/provider-usage.json`. It never stores transcript text. The workspace statusline wrapper at [`statusline.mjs`](statusline.mjs) preserves Honey's output and appends Sando's estimate plus provider usage.

## Metrics

```sh
node adapters/claude/sando/metrics.mjs
node adapters/claude/sando/metrics.mjs --json
```

The report uses `sando-report/v1` and separates local transform estimates from provider-reported savings. With RTK or another `PostToolUse` transformer active, estimates are measured at Sando's hook boundary and must not be added to the other plugin's percentage. See [`packages/sando/README.md`](../../../packages/sando/README.md) for the core API.

The bundle includes `bin/sando-statusline`, which resolves the installed plugin root itself. Set Claude's command-backed `statusLine` to `sando-statusline` and set `SANDO_HONEY_STATUSLINE` to the existing statusline command when another badge should be preserved.

Run the adapter-boundary probe with its captured PostToolUse fixture:

```sh
node adapters/claude/sando/tests/e2e-probe.mjs
```

It verifies replacement, artifact resolution, and receipt alignment without making a Claude or provider request.
