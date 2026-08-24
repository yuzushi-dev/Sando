<p align="center">
  <img src="assets/sando-mark.png" alt="Sando logo" width="96">
</p>

# Sando

Dependency-free Node 22 tooling for deterministic tool-output preparation and optional provider-request reduction around Claude Code and Codex.

Sando redacts common credential-shaped values, keeps a bounded inline view, preserves a complete redacted artifact, and records receipts and metrics. The core and hooks do not call an LLM or access the network; the opt-in proxy only forwards provider requests after deterministic history reduction.

## Install

Requires Node.js `22.22.x`.

```sh
git clone https://github.com/yuzushi-dev/Sando.git
cd Sando
npm test
```

No npm package is published yet.

## Claude Code

Run the repo-local plugin:

```sh
claude --plugin-dir "$PWD/adapters/claude/sando"
```

The hook applies preparation by default for supported result shapes. Set `SANDO_MODE=observe` or `SANDO_OBSERVE_ONLY=1` to keep the original result while retaining local candidate metrics. The plugin also exposes the read-only `prepare_tool_output` MCP tool. See [`adapters/claude/sando/README.md`](adapters/claude/sando/README.md).

At `Stop`, the Claude adapter parses numeric usage from the transcript and appends it to `~/.local/state/sando/provider-usage.json`. The active workspace statusline wraps Honey and shows readable savings, for example `🍯 honey:full · 🥪 2.51M token risparmiati · $5.02`. Provider input/output/cache counters remain available in the ledger and reports, not in the statusline.

## Codex

Load the self-contained plugin bundle in [`plugins/sando`](plugins/sando/README.md). Its `PostToolUse` hook is observational. For proven literal reads/searches, `PreToolUse` rewrites the pending shell command to the bundled CLI, so no MCP round-trip is needed:

```sh
node plugins/sando/cli.mjs read -- path/to/file
node plugins/sando/cli.mjs grep -F -- pattern path/to/file
```

The hook resolves the installed bundle path automatically; the CLI keeps the Codex shell sandbox inherited by the calling tool. Codex does not transparently replace an already-delivered arbitrary built-in tool result.

For classified literal file reads/searches, the Codex `PreToolUse` gate performs that rewrite automatically. Pipelines, shell syntax, unsafe paths, and ambiguous commands remain allowed and are counted as bypasses. Explicit terminal coverage is available through `sando_exec` when Codex supplies managed restricted sandbox metadata; it fails closed otherwise.

At `Stop`, the plugin parses Codex transcript usage into the same provider ledger. Codex's installed TUI has no verified custom status item, so this workspace exposes a session-scoped Sando line through tmux `status-right`:

```sh
tmux set-option -g status-right "#(node $PWD/scripts/sando-statusline.mjs --pane '#{pane_id}')"
```

The Codex hooks store the active `session_id` per pane and process in `~/.local/state/sando/active-sessions.json`; a missing or replaced process renders `🥪 —`.

## Provider proxy

The optional loopback proxy is the only Sando path that can reduce already-serialized history:

```sh
SANDO_UPSTREAM_URL=https://api.anthropic.com SANDO_PROXY_PORT=8787 npm run proxy
ANTHROPIC_BASE_URL=http://127.0.0.1:8787 claude --plugin-dir "$PWD/adapters/claude/sando"
```

For Codex, use a custom `model_providers.<id>` with `wire_api = "responses"` and `base_url = "http://127.0.0.1:8788"`. With ChatGPT OAuth, start the proxy against `https://chatgpt.com/backend-api/codex` and set `requires_openai_auth = true`; with an API key, use `https://api.openai.com/v1` and `env_key`. The proxy is deterministic, makes no LLM calls, preserves tool IDs/errors/order, and passes streaming responses through. It reduces model input context but does not retroactively redact host UI/transcripts. Optional budget gating is configured with `SANDO_CONTEXT_POLICY='{"maxHistoryTokens":120000}'`; additional deduplication, repeated-line compaction, and extractive history shake activate above 80% of that budget.

The semantic layer is shadow-only. `createSemanticCompactor()` accepts an injected completion function, redacts before that boundary, validates a versioned JSON summary, rejects missing/ungrounded facts, secrets, and oversized output, caches validated summaries, and never changes the forwarded body. The proxy can observe candidates with an explicit `semanticCompactor` callback; absent that callback, no LLM call occurs. The isolated live benchmark uses Codex `gpt-5.6-luna` first and falls back to Claude `claude-haiku-4-5` only when Codex is unavailable; it remains shadow-only and records provider-reported compactor cost.

## Benchmarks

Run the provider-free deterministic replay:

```sh
npm run benchmark:local -- --scenario terminal-noise --repetitions 5
```

Local token counts use `ceil(UTF-8 bytes / 4)`. They are estimates, not provider tokenization or billing data.

The statusline compacts local transform savings using `k` and `M`, and estimates their value from the selected model's standard input price when known. Provider input/output/cache counters are reported values kept for logs and reports; an exact saved-token number requires paired baseline/optimized A/B evidence and is never inferred from one run. A new session with no Sando events renders `🥪 —`; historical data is not marked `stale` in the statusline.

Live A/B runs require `--confirm-cost`, consume provider quota, and measure prepared prompts rather than a host `PostToolUse` lifecycle. Observational hook metrics are local candidate estimates, not provider savings. See [`benchmarks/README.md`](benchmarks/README.md) for commands, evidence, and limitations.

## Verify

```sh
npm test
npm run check
```
