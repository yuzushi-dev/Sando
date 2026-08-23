# Sando Codex plugin

Standalone Codex plugin. The manifest is `.codex-plugin/plugin.json`; hooks are discovered from `hooks/hooks.json`, not from a manifest `hooks` field. `.mcp.json` starts the bundled, network-free stdio server.

The `PostToolUse` hook is observational and defaults to `SANDO_MODE=observe`. It reads one JSON event from stdin and returns `{}`. Malformed events and telemetry failures are fail-open. An invalid `SANDO_POLICY` JSON object exits `2` and is the only fail-closed path. Codex lifecycle hooks do not currently provide this scaffold a portable way to replace the host's existing tool result, so the hook does not claim token reduction.

Effective preparation is available through MCP tool `prepare_tool_output` or the [reference core API](../../packages/sando/README.md). The plugin runtime is self-contained and is tested from a copied cache directory without `packages/`.

For an explicit, non-equivalent Codex fallback, set `SANDO_CODEX_FALLBACK=feedback` together with `SANDO_POLICY={"mode":"apply"}`. The hook returns `continue:false` feedback; it does not rewrite the tool result.

The hook persists safe savings metrics in the default local state file or the
absolute `SANDO_METRICS_PATH` override. View them with
`node plugins/sando/metrics.mjs` or consume the
`sando-report/v1` JSON with `node plugins/sando/metrics.mjs --json`.
The report separates estimated transform savings from provider-reported
savings and exposes current session, average session, cumulative, daily, ISO
weekly, and monthly values.

Local checks:

```sh
python3 "$PLUGIN_CREATOR_ROOT/scripts/validate_plugin.py" plugins/sando
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | node plugins/sando/mcp/server.mjs
```

No marketplace or user configuration is modified.
