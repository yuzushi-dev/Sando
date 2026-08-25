# Sando benchmarks

Sando has two measurement modes: a provider-free local replay and a gated live prompt A/B.

## Cache and history probes

Deterministic diagnostics over committed result files and local transcripts. **No network, no
provider calls, no cost** — safe to run any time, including in CI.

Three take no arguments and run as a set:

```sh
npm run probes                    # cache-control + cache-hits + cache-attribution
```

| Script | Question it answers |
|---|---|
| `npm run probe:cache-control` | Does the history transform preserve `cache_control` breakpoints the host placed? Four request shapes, marker count in vs out. |
| `npm run probe:cache-hits` | Which recorded run produced a given cache-hit figure, and what is the hit rate per measured path? |
| `npm run probe:cache-attribution` | *Why* did the cache miss — `tools-changed`, `system-changed`, `history-rewritten`, `no-breakpoint`, `below-minimum`, `cold-start`, `ttl-expired`, or honestly `unexplained`. Also reports cache-write volume and write-to-read ratio. |

Two take a transcript. Claude Code transcripts live at
`~/.claude/projects/<slug>/<session-id>.jsonl`:

```sh
npm run probe:rewrite-payback -- ~/.claude/projects/<slug>/<session>.jsonl
npm run probe:rewrite-payback -- ~/.claude/projects/*/*.jsonl        # table + aggregate
npm run probe:prefix-divergence -- ~/.claude/projects/<slug>/<session>.jsonl 300 60000
```

- **`probe:rewrite-payback`** — does a history rewrite reclaim enough to pay for the cache it
  invalidates? Anthropic bills a cache read at `0.1×` base input and a 5-minute write at `1.25×`, so
  with `S` reclaimed, `P` suffix re-prefilled and `K` further turns:
  `rewrite wins ⟺ S/P > 1.15/(1.25 + 0.10K)`. The threshold is a ratio, independent of `P`: K=0 needs
  92%, K=10 needs 51%, K=50 needs 18%. This is the criterion `policy.cacheRewriteRatio` implements.
  Pass several transcripts for a per-file table plus an aggregate.
- **`probe:prefix-divergence`** — replays a growing conversation and reports, per turn, the first
  message index whose serialization differs from the previous turn: the point from which the
  provider's cumulative hash must be re-billed. Args: `<transcript> [maxTurns] [maxHistoryTokens]`.

### Why not use the weekly savings counter for this

`metrics-cli.mjs`'s `estimatedTransformSavingsTokens` (daily/weekly/monthly) measures
`optimizeToolOutput` — truncation of a **single tool output** as it is produced, written only by
`hook-cli.mjs`. **`proxy.mjs` writes no metrics at all.** The cache questions above concern
`transformProviderRequest`, which rewrites the message history across turns. Different layer, and
`metrics.json` records no cache counters, so the figure cannot answer them.

### Caveats

- Token counts are the `bytes/4` estimate, the same uncalibrated heuristic Sando uses internally — not
  provider-billed tokens. Event counts and message indices are exact; absolute magnitudes are not.
- `benchmarks/results/` is gitignored, so `probe:cache-hits` and `probe:cache-attribution` report only
  what exists on the local filesystem.
- Repo fixtures under `benchmarks/fixtures/` carry `toolName: "ToolResult"` and no `input`, so they
  cannot trigger the supersede or dedupe paths. Use a real transcript for the transcript-taking probes.

## Local replay

The local benchmark replays the same fixtures through a raw baseline and Sando. It reports paired inline estimates, artifact recovery, required-fact presence, model-visible quality, and secret-leak checks.

```sh
npm run benchmark:local
npm run benchmark:local -- --scenario terminal-noise --repetitions 5
```

The estimate is `ceil(UTF-8 bytes / 4)`. It is deterministic local accounting, not provider tokenization or billing data. The default run uses `read-large` and `terminal-noise`; `--scenario` selects a fixture from `benchmarks/fixtures/`.

Reports include prompt digests, commit and environment metadata, working-tree provenance, and a `local-replay` measurement declaration. A fact found only in an artifact is recoverable but is not model-visible inline context.

The provider-free local runner now includes `read-structural` so the structural-Read path is measured alongside the existing generic-read and terminal-output cases. Its result is an estimate, not a Claude/Codex provider counter.

The provider-free context-proxy tests cover deterministic repeated-Read pruning, exact historical result deduplication, repeated-line compaction, extractive history shake, and 80%-budget gating across Anthropic Messages, OpenAI Chat Completions, and OpenAI Responses shapes, plus a loopback upstream with streaming response passthrough. They do not consume provider quota. A proxy live A/B still requires explicit quota approval and paired provider counters.

## Live prompt A/B

Live runs require explicit quota approval:

```sh
npm run benchmark:live -- --host claude --model sonnet --max-budget-usd 0.25 \
  --claude-plugin-dir adapters/claude/sando --repetitions 15 --confirm-cost
npm run benchmark:live -- --host codex --scenario terminal-noise \
  --repetitions 15 --confirm-cost

# Codex real-tool aggregate: CLI routing plus explicit sando_exec
node benchmarks/live/codex-e2e-run.mjs --route all --repetitions 1 --confirm-cost
```

Claude requires either `--max-budget-usd` or explicit `--unlimited-budget`. Live runs record provider usage, prompt digests, redacted diagnostics, client version, resolved model when available, and provenance. Claude input accounting combines `input_tokens`, `cache_creation_input_tokens`, and `cache_read_input_tokens`; Codex keeps `input_tokens` as reported and records cached input separately.

These are prompt-level measurements. The runner disables tools and embeds baseline or prepared context in the prompt, so it does not exercise Claude or Codex `PostToolUse` end to end. Passing `--claude-plugin-dir` does not change that. Codex feedback fallback is also not a transparent rewrite.

## Current live evidence

Snapshot: 2026-08-23. Values below are provider-reported input counters, not local estimates.

| Host | Client / model | Scenarios | Pairs | Baseline → optimized input | Saved | Actual cost |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Claude Code | `2.1.233` / `claude-sonnet-5` | 10 | 50 | 1,268,060 → 1,044,056 | 17.67% | `$7.904935` |
| Codex CLI | `0.149.0` / `gpt-5.6-luna` | 10 | 10 | 229,836 → 200,449 | 12.79% | not recorded |

The reports are blocked by missing `modelVisibleQuality`, `artifactResolvable`, and `secretLeak` evidence. That block is expected for this prompt-level harness; the runs do not establish end-to-end host rewriting, artifact resolution, or leak results.

Do not run live commands without quota approval. For an externally stopped Claude campaign, replace `--max-budget-usd` with `--unlimited-budget`.

## Real tool A/B evidence

Snapshot: 2026-08-24. These campaigns used live provider counters and executed the real tool path. Every listed pair passed the correctness, model-visible, artifact, and leak gates.

| Host | Client / model | Tool path | Baseline → optimized input | Saved | Median saved |
| --- | --- | --- | ---: | ---: | ---: |
| Claude Code | `2.1.233` / `claude-sonnet-5` | Bash + PostToolUse `observe` → `apply` | 668,667 → 652,123 | 16,544 (2.47%) | 1,091 (2.45%) |
| Codex CLI | `0.149.1` / default (not exposed in JSON) | built-in shell → MCP `sando_exec` | 694,062 → 753,333 | −59,271 (−8.54%) | −3,711 (−8.02%) |
| Codex CLI | `0.149.1` / default (not exposed in JSON) | built-in shell → `sando` CLI via `PreToolUse` | 416,174 → 408,620 | 7,554 (1.82%) | 753 (1.81%) |
| Claude Code | `2.1.233` / `claude-opus-5` | Sando plugin `PostToolUse apply` | 136,861 → 131,388 | 5,473 (4.00%) | 1,094 (4.00%) |
| Codex CLI | `0.149.1` / default (not exposed in JSON) | Sando plugin `PreToolUse` → CLI | 207,896 → 204,472 | 3,424 (1.65%) | 686 (1.65%) |

The CLI route removes the MCP schema/call overhead for classified literal reads and produced a positive saving on this fixture. The earlier MCP route remains functionally valid but negative here. Reports: `live-claude-e2e.json`, `live-codex-tools.json`, and `live-codex-cli-tools.json` in the ignored `benchmarks/results/` directory; the CLI report was generated from the current dirty worktree and its evidence is not a release benchmark.

Single-cycle Codex aggregate estimate on a clean worktree: built-in shell twice → Sando CLI plus bounded `sando_exec`, 64,771 → 63,066 input tokens, saved 1,705 (2.63%); all quality gates passed. This is an estimate, not a stable total: use a multi-cycle campaign for a representative percentage.

Fresh five-pair plugin comparison reports: `live-sando-claude-5.json` and `live-sando-codex-5-retry.json`. Both passed all quality gates. Claude saved 5,473 provider input tokens (4.00%); Codex saved 3,424 (1.65%). Output tokens are reported separately because Sando primarily reduces input context.

Current five-pair run after the extractive-history work (2026-08-24), using the real host tool paths: Claude Code `2.1.233` / `claude-opus-5` saved 22,016 input tokens (145,788 → 123,772; 15.10%; median 15.24%), with 5/5 quality gates; Codex CLI `0.149.1` / default model saved 3,773 input tokens (207,956 → 204,183; 1.81%; median 1.84%), with 5/5 quality gates. Reports: `live-sando-claude-5-current.json` and `live-sando-codex-5-current-retry.json` in ignored `benchmarks/results/`. These validate live tool-output reduction; the provider-request history-shake proxy is not exercised by the host hooks yet.

## Live provider-proxy A/B

The provider proxy is now measured separately from the host-hook campaigns. It sends the same real tool conversation through the provider endpoint, with the optimized lane using the loopback proxy and `SANDO_CONTEXT_POLICY`; it does not edit persistent Claude or Codex configuration and makes no LLM calls.

```sh
node benchmarks/live/proxy-e2e-run.mjs --host claude --model claude-opus-5 \
  --max-budget-usd 0.25 --repetitions 5 --confirm-cost \
  --out benchmarks/results/live-proxy-claude-5-current.json
node benchmarks/live/proxy-e2e-run.mjs --host codex --model gpt-5.6-luna \
  --repetitions 5 --confirm-cost \
  --out benchmarks/results/live-proxy-codex-5-current.json
```

Snapshot: 2026-08-24. Both campaigns completed 5/5 quality gates with provider-reported counters:

| Host | Provider boundary | Baseline → optimized input | Saved | Median saved |
| --- | --- | ---: | ---: | ---: |
| Claude Code `2.1.233` / `claude-opus-5` | Anthropic Messages via loopback proxy | 139,730 → 74,233 | 65,497 (46.87%) | 46.91% |
| Codex CLI `0.149.1` / `gpt-5.6-luna` | Responses `custom_tool_call*` via loopback proxy | 309,567 → 265,209 | 44,358 (14.33%) | 13.92% |

The exact aggregate in each report is authoritative; cache fields and output tokens remain reported separately. The Codex proxy uses the ChatGPT OAuth backend by default; an API-key run can pass `--upstream https://api.openai.com/v1`.

## Semantic shadow spike

The semantic adapter is not enabled in the provider proxy and makes no live model calls by default. The local runner uses a fixture oracle to test accounting, fact recall, timeout/fallback behavior, and cache reuse:

```sh
npm run benchmark:semantic-shadow -- --repetitions 10
npm run benchmark:semantic-shadow -- --repetitions 10 --min-input-tokens 1000
```

The default `8000`-token trigger produced no candidates on the current fixtures; lowering it to `1000` produced a provider-free oracle result of 59.72% net savings, 90% cache hits, and 100% fact recall over 100 events (124,952 net estimated tokens; p95 0 ms). This is a harness result, not an LLM quality or provider-cost claim.

### Real CLI semantic shadow

The live adapter sends only the redacted semantic prompt through an isolated CLI child, with a strict JSON schema, no tools, no Sando proxy routing, timeout kill, grounding checks, and fail-open fallback. It never applies the summary:

```sh
npm run benchmark:semantic-shadow-live -- --provider auto \
  --min-input-tokens 1000 --confirm-cost \
  --out benchmarks/results/semantic-shadow-auto-10.json
npm run benchmark:semantic-shadow-live -- --provider claude \
  --model claude-haiku-4-5 --min-input-tokens 1000 --confirm-cost \
  --out benchmarks/results/semantic-shadow-claude-10.json
```

`auto` chooses Codex `gpt-5.6-luna`; if its binary is absent, it chooses Claude `claude-haiku-4-5`. It does not switch provider after a runtime failure, so reports remain comparable and attributable.

Snapshot 2026-08-24, 10 fixture conversations / 12 events, trigger 1,000 estimated tokens:

| Provider | Candidates | Fact recall | Compactor input + output | Net result | P95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Codex `gpt-5.6-luna` | 6/12 | 100% | 138,473 + 886 | −116,501 (−381.96%) | 8.55 s |
| Claude `claude-haiku-4-5` | 4/12 | 100% | 24,781 + 2,290 | −11,290 (−37.02%) | 14.59 s |

The current fixture set is below break-even for an LLM compactor: roughly 30k input tokens/event for Codex and 9k for Claude under these CLI overheads, before cache reuse. The 8k production trigger remains conservative; the live result does not authorize apply.
