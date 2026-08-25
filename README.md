<p align="center">
  <img src="assets/sando-mark.png" alt="Sando logo" width="96">
</p>

# Sando

Sando cuts what Claude Code and Codex charge you to re-read their own output. It redacts secrets, caps oversized tool results, and, if you turn it on, trims request history before it's sent, all without calling an LLM itself.

## Measured savings

**45.7% fewer input tokens, best case.** Measured against the real Anthropic API (provider-billed, not estimated), median of 5 live runs. Codex on the same test: 13.9%. Reproduce it with `node benchmarks/live/proxy-e2e-run.mjs`.

| Scenario | Saving |
|---|---|
| Short session, repetitive tool output | **45.7%** (live, n=5) |
| Long session, no prompt caching | ~10% median |
| Long session, with prompt caching | ~0%, on purpose |

That 45.7% is the case Sando is built for: a short session with one big, repeated tool result. Long sessions save less. And if your host already caches prompts (Claude Code does), Sando often saves nothing on purpose: rewriting history breaks the cache, so Sando skips any rewrite that would cost more than it saves.

Check your own sessions instead of trusting the table:

```sh
npm run probe:rewrite-payback -- ~/.claude/projects/*/*.jsonl
```

## Install

Requires Node.js `22.22.x`. No npm package yet.

```sh
git clone https://github.com/yuzushi-dev/Sando.git
cd Sando
npm test
```

## Claude Code

```sh
claude --plugin-dir "$PWD/adapters/claude/sando"
```

The hook redacts and bounds tool output by default. Set `SANDO_MODE=observe` (or `SANDO_OBSERVE_ONLY=1`) to keep the original output and just collect metrics. It also exposes a read-only `prepare_tool_output` MCP tool.

At session end, Claude usage gets appended to `~/.local/state/sando/provider-usage.json`; a statusline can read that file and show running savings, e.g. `🥪 2.51M tokens saved (est.)`.

## Codex

```sh
node plugins/sando/cli.mjs read -- path/to/file
node plugins/sando/cli.mjs grep -F -- pattern path/to/file
```

Codex's `PostToolUse` hook is observation-only; for plain file reads/greps, `PreToolUse` reroutes the command to Sando's CLI before it runs, no MCP round-trip needed. For everything else, three MCP tools are available: `sando_read`, `sando_grep`, and `sando_exec` (runs one command through Codex's own sandbox). `SANDO_OBSERVE_ONLY=1` forces observation regardless of policy.

Codex has no built-in status line, so this repo drives one through tmux:

```sh
tmux set-option -g status-right "#(node $PWD/scripts/sando-statusline.mjs --pane '#{pane_id}')"
```

## Provider proxy (optional)

The only Sando path that can shrink history already sent to the model:

```sh
SANDO_UPSTREAM_URL=https://api.anthropic.com SANDO_PROXY_PORT=8787 npm run proxy
ANTHROPIC_BASE_URL=http://127.0.0.1:8787 claude --plugin-dir "$PWD/adapters/claude/sando"
```

For Codex, point a custom `model_providers.<id>` (`wire_api = "responses"`, `base_url = "http://127.0.0.1:8788"`) at the proxy instead.

Deterministic, no LLM calls, streams through unchanged. It dedupes and prunes repeated tool results above `SANDO_CONTEXT_POLICY`'s token budget, and skips any rewrite that would cost more (in cache invalidation) than it saves, so a warm prompt cache stays warm. There's also a shadow-only semantic-compaction layer that never touches the forwarded request; it only logs what an LLM summary would have saved.

## Benchmarks

```sh
npm run benchmark:local -- --scenario terminal-noise --repetitions 5
```

Local counts are `bytes/4` estimates, not provider billing. Live, provider-billed numbers require `--confirm-cost` and real API quota; see `benchmarks/live/` for the scripts behind the numbers above.

## Verify

```sh
npm test
npm run check
```
