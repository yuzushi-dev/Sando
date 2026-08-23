# Sando Codex plugin

Self-contained Codex plugin bundle. The manifest is `.codex-plugin/plugin.json`; hooks and the network-free MCP server are declared by companion files in this directory.

## Use

Load this directory as a Codex plugin. The `PostToolUse` hook defaults to observation and returns `{}`. It records receipts and metrics but does not transparently rewrite an already-delivered tool result.

Use the bundled read-only `prepare_tool_output` MCP tool for effective deterministic preparation. It returns bounded inline output and an optional complete redacted artifact payload without filesystem or network writes.

For an explicit, non-equivalent fallback, set `SANDO_CODEX_FALLBACK=feedback` together with `SANDO_POLICY={"mode":"apply"}`. The hook returns `continue:false` feedback and stops the turn; it does not rewrite the tool result.

Malformed events and telemetry failures are fail-open. Invalid `SANDO_POLICY` exits with status `2`.

## Metrics

```sh
node plugins/sando/metrics.mjs
node plugins/sando/metrics.mjs --json
```

The JSON report is `sando-report/v1` and separates local transform estimates from provider-reported savings.

No marketplace or user configuration is modified.
