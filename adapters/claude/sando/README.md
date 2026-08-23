# Sando for Claude Code

Repo-local or copied/cache Claude Code plugin bundle.

## Install

```sh
claude --plugin-dir "$PWD/adapters/claude/sando"
```

The `PostToolUse` hook is observational by default and records receipts and metrics. Set `SANDO_MODE=apply` to replace Claude output for string results and Bash-shaped results containing `stdout` and `stderr`. Other structured result shapes remain unchanged. `SANDO_MODE=dry-run` prepares and records a candidate without replacing the result.

When replacement produces an artifact reference, the adapter writes the complete redacted artifact atomically under `cwd/.sando/sando/artifacts` with private file permissions. The core itself does not write artifacts.

The bundle also exposes the read-only, network-free `prepare_tool_output` MCP tool. Malformed events, persistence failures, and telemetry failures are fail-open. Invalid `SANDO_POLICY` exits with status `2`.

## Metrics

```sh
node adapters/claude/sando/metrics.mjs
node adapters/claude/sando/metrics.mjs --json
```

The report uses `sando-report/v1` and separates local transform estimates from provider-reported savings. See [`packages/sando/README.md`](../../../packages/sando/README.md) for the core API.

No Claude configuration or marketplace entry is changed.
