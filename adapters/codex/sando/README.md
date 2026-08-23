# Sando Codex adapter

Standalone companion bundle for direct launcher use or a copied/cache directory. The installable Codex plugin is [`plugins/sando`](../../../plugins/sando/README.md).

## Hook behavior

The `PostToolUse` hook is observational by default and returns `{}`. It records receipts and metrics but does not rewrite the already-delivered Codex tool result.

For an explicit, non-equivalent fallback, set `SANDO_CODEX_FALLBACK=feedback` with `SANDO_POLICY={"mode":"apply"}`. The hook returns `continue:false` feedback and stops the turn; it still does not transparently replace the result.

Effective preparation is available through the read-only `prepare_tool_output` MCP tool.

```sh
printf '%s' '{"hook_event_name":"PostToolUse","tool_name":"Read","tool_response":"ok","cwd":"/tmp"}' \
  | node adapters/codex/sando/hooks/post-tool-use.mjs
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  | node adapters/codex/sando/mcp/server.mjs
```

Malformed events and telemetry failures are fail-open. Invalid `SANDO_POLICY` exits with status `2`.

## Metrics

```sh
node adapters/codex/sando/metrics.mjs
node adapters/codex/sando/metrics.mjs --json
```

The report uses `sando-report/v1` and does not claim provider savings without paired provider counters.
