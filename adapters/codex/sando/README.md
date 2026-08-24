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

The `PreToolUse` gate rewrites only proven literal `cat -- FILE` and `rg/grep -F -- PATTERN PATH` commands to the bundled `bin/sando` CLI before execution. This avoids an MCP round-trip while preserving the calling Codex shell sandbox. Pipelines, shell syntax, unsafe paths, and ambiguous commands remain allowed and are recorded as bypasses. Inspect coverage with `node adapters/codex/sando/coverage.mjs`.

The CLI applies the shared OMP-compatible reductions: structural summaries for eligible unselected reads, OMP-sized literal grep bounds, repeated-line collapse for terminal output, redaction, and artifact-backed recovery.

The `PreToolUse`/`Stop` hooks associate the Codex `session_id` with the current tmux pane and store only that marker in `~/.local/state/sando/active-sessions.json`. The `Stop` hook also reads `transcript_path`, keeps numeric `token_count.last_token_usage` or `turn.completed.usage` counters, and appends them idempotently to `~/.local/state/sando/provider-usage.json`. It never stores transcript text. Configure the external status surface with:

```sh
tmux set-option -g status-right "#(node $PWD/scripts/sando-statusline.mjs --pane '#{pane_id}')"
```

The statusline is session-scoped. It renders `🥪 —` when the pane has no active marker or when its Codex process has changed, so historical savings are not shown in a new session.

Codex's native TUI status line remains unchanged; tmux is the external status surface. The line uses compact `k`/`M` savings and omits provider input/output/cache counters.

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

On the installed Codex CLI `0.149.0`, MCP is additive, `PreToolUse` can rewrite inputs but not prepared outputs, and `PostToolUse` cannot rewrite a completed result before model context construction. The adapter provides partial transparent coverage for classified literal reads/searches through its CLI; arbitrary built-in output replacement remains unavailable, and provider savings are not claimed without paired counters.

Malformed events and telemetry failures are fail-open. Invalid `SANDO_POLICY` exits with status `2`.

## Metrics

```sh
node adapters/codex/sando/metrics.mjs
node adapters/codex/sando/metrics.mjs --json
```

The report uses `sando-report/v1` and does not claim provider savings without paired provider counters.

## Optional provider proxy

Codex's custom provider configuration can point its OpenAI Responses requests at the loopback proxy. Start the proxy against the OpenAI API root:

```sh
SANDO_UPSTREAM_URL=https://api.openai.com SANDO_PROXY_PORT=8788 npm run proxy
```

Then add a user-level provider/profile entry (do not put this in a project file):

```toml
[model_providers.sando]
name = "OpenAI via Sando"
base_url = "http://127.0.0.1:8788/v1"
wire_api = "responses"
env_key = "OPENAI_API_KEY"

[profiles.sando]
model_provider = "sando"
```

Run `codex --profile sando`. The proxy deterministically prunes safe historical tool results before `/v1/responses` and streams the provider response unchanged. Set `SANDO_CONTEXT_POLICY='{"maxHistoryTokens":120000}'` to gate exact-result deduplication, repeated-line compaction, and extractive history shake at 80% of the request budget. Shake keeps head/tail/high-signal lines and is not a semantic summary. It makes no LLM calls, does not log credentials, and does not alter the Codex transcript already rendered by the host.
