<p align="center">
  <img src="assets/sando-mark.png" alt="Sando logo" width="96">
</p>

# Sando

Dependency-free Node 22 tooling for deterministic tool-output preparation and optional provider-request reduction around Claude Code and Codex.

Sando redacts common credential-shaped values, keeps a bounded inline view, preserves a complete redacted artifact, and records receipts and metrics. The core and hooks do not call an LLM or access the network; the opt-in proxy only forwards provider requests after deterministic history reduction.

## Measured savings

**Peak: 45.7% fewer input tokens.** Median of 5 paired live runs against the real Anthropic API,
counted from provider-reported billing rather than estimated, with every run passing its
output-quality check. Codex on the same harness: 13.9%. Reproduce with
`benchmarks/live/proxy-e2e-run.mjs`.

Read the next paragraph before quoting that number.

**It comes from a short session.** That benchmark is a two-message exchange with one large repetitive
tool result — the shape Sando is best at. The saving is real and provider-billed, but it is a peak,
not a typical figure, and it does **not** extrapolate to long sessions.

| Scenario | Saving | Basis |
|---|---|---|
| Short session, repetitive tool output | **45.7%** | live, provider-billed, n=5 |
| Long session, host without prompt caching | ~10% median (0–30%) | `bytes/4` estimate, 25 real sessions |
| Long session, host **with** prompt caching (Claude Code) | **~0%** | deliberate — see below |

**Why ~0% is the right answer when your host caches.** Claude Code already places 3 of Anthropic's 4
`cache_control` breakpoints, and a cache read bills at 0.1× fresh input. Rewriting history to shave
tokens invalidates that cached prefix. Across 685 rewrites in 23 real sessions, only 1.5% reclaimed
enough to pay back the cache-write premium. So Sando prices each rewrite and **declines the ones that
would cost more than they save** (`policy.cacheRewriteRatio`).

Fewer tokens on the wire is not the same as a smaller bill. Sando optimizes for the bill, which
sometimes means doing nothing.

Savings track **repetition, not length** — repeated reads of the same files and repetitive command
output are what Sando removes. A 250k-token session measured 8.8%; a 128k-token one measured 22.1%.
Measure your own instead of trusting any of the above:

```sh
npm run probe:rewrite-payback -- ~/.claude/projects/*/*.jsonl
```

Separately, the always-on hook path bounds individual tool outputs before they reach the model. That
runs regardless of caching and is reported by `node packages/sando/src/metrics-cli.mjs`, labelled as
an estimate — it is byte arithmetic, not provider-billed tokens.

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

At `Stop`, the Claude adapter parses numeric usage from the transcript and appends it to `~/.local/state/sando/provider-usage.json`. The active workspace statusline wraps Honey and shows readable savings, for example `🍯 honey:full · 🥪 2.51M token risparmiati (stima)`.

Savings are only priced when they come from real provider-reported usage, and then only as an upper bound (`≤$5.02`): the price table carries uncached input rates with no cache multipliers, while cache reads bill at 0.1×. Mechanical `bytes/4` estimates are never converted to currency — they are labelled `(stima)` and shown as tokens only. Provider input/output/cache counters remain available in the ledger and reports, not in the statusline.

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

For Codex, use a custom `model_providers.<id>` with `wire_api = "responses"` and `base_url = "http://127.0.0.1:8788"`. With ChatGPT OAuth, start the proxy against `https://chatgpt.com/backend-api/codex` and set `requires_openai_auth = true`; with an API key, use `https://api.openai.com/v1` and `env_key`. The proxy is deterministic, makes no LLM calls, preserves tool IDs/errors/order, and passes streaming responses through. It reduces model input context but does not retroactively redact host UI/transcripts. Optional budget gating is configured with `SANDO_CONTEXT_POLICY='{"maxHistoryTokens":120000}'`; additional deduplication, repeated-line compaction, and extractive history shake activate above 80% of that budget. A rewrite that would invalidate a warm provider cache is skipped unless it reclaims enough of the suffix to pay for the cache-write it forces (`policy.cacheRewriteRatio`, default 0.51) — or unless the request has been idle long enough (default 65 min, past Anthropic's longest published TTL) that the cache is cold on its own, in which case the guard is bypassed for free (`policy.cacheIdleFlushMs`).

`npm run proxy` records one JSONL line per forwarded request to `~/.local/state/sando/proxy-requests.jsonl` (override with `--metrics-path` or `SANDO_PROXY_METRICS_PATH`): the mechanical token reduction Sando made and, when parseable from the response, the provider's real billed usage (including cache read/write tokens). `npm run proxy:report` summarizes that log — requests, mechanical tokens saved, cache hit rate, and how often the idle-flush and ratio guards fired. There is no live A/B in day-to-day use (only the optimized body is ever sent), so this reports what happened, not a percent-vs-baseline claim; `benchmarks/live/idle-flush-real-session-run.mjs` is what produces the latter, from a real, already-idle transcript replayed against both variants.

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
