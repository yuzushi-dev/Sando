# Sando Codex adapter

Standalone companion bundle for direct launcher use or a copied/cache directory. The installable Codex plugin is [`plugins/sando`](../../../plugins/sando/README.md).

## Hook behavior

The `PostToolUse` hook is observational by default and returns `{}`. It records receipts and metrics but does not rewrite the already-delivered Codex tool result.

Force observation for real sessions, including when a policy or inherited environment requests another mode:

```sh
SANDO_OBSERVE_ONLY=1 codex
```

The flag accepts `1`, `true`, or `yes`; it overrides `SANDO_POLICY.mode` and keeps the hook observational while retaining local candidate estimates.

For an explicit, non-equivalent fallback, set `SANDO_CODEX_FALLBACK=feedback` with `SANDO_POLICY={"mode":"apply"}`. The hook returns `continue:false` feedback and stops the turn; it still does not transparently replace the result.

Explicit preparation is available through three read-only MCP tools:

- `sando_read`: reads a workspace-relative regular file.
- `sando_grep`: searches a workspace-relative file or directory for a literal string.
- `prepare_tool_output`: prepares output supplied by the caller.

They return bounded, redacted inline output and an optional artifact payload. They reject absolute paths, symlinks, and paths outside the supplied `cwd`; they do not transparently replace a built-in Codex tool result.

For terminal work, `sando_exec` executes one non-interactive command through `codex sandbox`, using Codex's `codex/sandbox-state-meta`. It fails closed without managed restricted sandbox metadata, bounds and redacts stdout/stderr, reports exit status, timeout, cancellation, and binary output, and rejects TTY/interactive calls. It is an explicit MCP tool; it does not transparently replace built-in Bash execution.

The `PreToolUse` gate blocks only proven literal `cat -- FILE` and `rg/grep -F -- PATTERN PATH` commands and directs Codex to the corresponding MCP tool. Pipelines, shell syntax, unsafe paths, and ambiguous commands remain allowed and are recorded as bypasses. Inspect coverage with `node adapters/codex/sando/coverage.mjs`.

The `Stop` hook reads `transcript_path`, keeps numeric `token_count.last_token_usage` or `turn.completed.usage` counters, and appends them idempotently to `~/.local/state/sando/provider-usage.json`. It never stores transcript text. For the active workspace statusline, use:

```sh
node scripts/sando-statusline.mjs
```

Codex's native TUI status line remains unchanged; tmux is the external status surface.

```sh
printf '%s' '{"hook_event_name":"PostToolUse","tool_name":"Read","tool_response":"ok","cwd":"/tmp"}' \
  | node adapters/codex/sando/hooks/post-tool-use.mjs
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  | node adapters/codex/sando/mcp/server.mjs
```

## Codex capability boundary

```sh
node adapters/codex/sando/capability-probe.mjs
```

On the installed Codex CLI `0.149.0`, MCP is additive, `PreToolUse` can rewrite inputs but not prepared outputs, and `PostToolUse` cannot rewrite a completed result before model context construction. Transparent Read/Grep/Bash replacements remain unavailable; provider savings are not claimed for built-in tools.

Malformed events and telemetry failures are fail-open. Invalid `SANDO_POLICY` exits with status `2`.

## Metrics

```sh
node adapters/codex/sando/metrics.mjs
node adapters/codex/sando/metrics.mjs --json
```

The report uses `sando-report/v1` and does not claim provider savings without paired provider counters.
