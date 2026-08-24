# Sando Codex plugin

Self-contained Codex plugin bundle. The manifest is `.codex-plugin/plugin.json`; hooks and the network-free MCP server are declared by companion files in this directory.

## Use

Load this directory as a Codex plugin. The `PostToolUse` hook defaults to observation and returns `{}`. It records receipts and metrics but does not transparently rewrite an already-delivered tool result.

To guarantee observation during real usage:

```sh
SANDO_OBSERVE_ONLY=1 codex
```

The flag accepts `1`, `true`, or `yes`; it overrides `SANDO_POLICY.mode` and still records local candidate estimates.

Use the bundled read-only MCP tools for explicit preparation:

- `sando_read`: reads a workspace-relative regular file.
- `sando_grep`: searches a workspace-relative file or directory for a literal string.
- `prepare_tool_output`: prepares output supplied by the caller.

All three return bounded, redacted inline output and an optional artifact payload. They do not write files or access the network. Paths stay inside the supplied absolute `cwd`; symlinks and absolute input paths are rejected. These tools do not transparently replace a built-in Codex tool result.

`sando_exec` is the explicit terminal tool. It runs one non-interactive command through `codex sandbox` with Codex's `codex/sandbox-state-meta`; it fails closed without managed restricted sandbox metadata, bounds and redacts stdout/stderr, reports exit status, timeout, cancellation, and binary output, and rejects TTY/interactive calls. It does not transparently replace built-in Bash execution.

The `PreToolUse` gate blocks proven literal `cat -- FILE` and `rg/grep -F -- PATTERN PATH` commands before they run and directs Codex to `sando_read` or `sando_grep`. Pipelines, shell syntax, unsafe paths, and ambiguous commands remain allowed and are recorded as bypasses. Inspect the evidence with `node plugins/sando/coverage.mjs`.

The `PreToolUse` gate provides automatic routing only for classified literal read/search commands. Ambiguous shell commands remain allowed and are recorded as bypasses; use `sando_exec` explicitly for terminal coverage.

The `Stop` hook reads `transcript_path`, keeps numeric `token_count.last_token_usage` or `turn.completed.usage` counters, and appends them idempotently to `~/.local/state/sando/provider-usage.json`. It never stores transcript text. The active workspace uses [`scripts/sando-statusline.mjs`](../../scripts/sando-statusline.mjs) in tmux because Codex's native TUI has no verified custom status item.

## Codex capability boundary

```sh
node plugins/sando/capability-probe.mjs
```

The probe records the installed host contract. On Codex CLI `0.149.0`, MCP tools are additive, `PreToolUse` can rewrite tool inputs but not prepared outputs, and `PostToolUse` cannot rewrite a completed tool result (Sando's feedback fallback remains explicit and non-transparent). Transparent replacements for built-in Read/Grep/Bash remain unavailable; Sando's explicit read/grep tools are not replacements. The report never claims provider savings when built-ins cannot be displaced.

For an explicit, non-equivalent fallback, set `SANDO_CODEX_FALLBACK=feedback` together with `SANDO_POLICY={"mode":"apply"}`. The hook returns `continue:false` feedback and stops the turn; it does not rewrite the tool result.

Malformed events and telemetry failures are fail-open. Invalid `SANDO_POLICY` exits with status `2`.

## Metrics

```sh
node plugins/sando/metrics.mjs
node plugins/sando/metrics.mjs --json
```

The JSON report is `sando-report/v1` and separates local transform estimates from provider-reported savings.

No marketplace or user configuration is modified.
