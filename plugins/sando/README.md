# Sando Codex plugin

Self-contained Codex plugin bundle. The manifest is `.codex-plugin/plugin.json`; hooks and the network-free MCP server are declared by companion files in this directory.

## Use

Load this directory as a Codex plugin. The `PostToolUse` hook defaults to observation and returns `{}`. It records receipts and metrics but does not transparently rewrite an already-delivered tool result.

Use the bundled read-only `prepare_tool_output` MCP tool for explicit deterministic preparation. It returns bounded inline output and an optional complete redacted artifact payload without filesystem or network writes; it does not transparently replace a built-in Codex tool result.

## Codex capability boundary

```sh
node plugins/sando/capability-probe.mjs
```

The probe records the installed host contract. On Codex CLI `0.149.0`, MCP tools are additive, `PreToolUse` can rewrite tool inputs but not prepared outputs, and `PostToolUse` cannot rewrite a completed tool result (Sando's feedback fallback remains explicit and non-transparent). Transparent Read/Grep/Bash wrapper MCP tools are therefore marked `impossible` and are not shipped. The report never claims provider savings when built-ins cannot be displaced.

For an explicit, non-equivalent fallback, set `SANDO_CODEX_FALLBACK=feedback` together with `SANDO_POLICY={"mode":"apply"}`. The hook returns `continue:false` feedback and stops the turn; it does not rewrite the tool result.

Malformed events and telemetry failures are fail-open. Invalid `SANDO_POLICY` exits with status `2`.

## Metrics

```sh
node plugins/sando/metrics.mjs
node plugins/sando/metrics.mjs --json
```

The JSON report is `sando-report/v1` and separates local transform estimates from provider-reported savings.

No marketplace or user configuration is modified.
