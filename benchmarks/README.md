# Sando benchmarks

Sando has two measurement modes: a provider-free local replay and a gated live prompt A/B.

## Local replay

The local benchmark replays the same fixtures through a raw baseline and Sando. It reports paired inline estimates, artifact recovery, required-fact presence, model-visible quality, and secret-leak checks.

```sh
npm run benchmark:local
npm run benchmark:local -- --scenario terminal-noise --repetitions 5
```

The estimate is `ceil(UTF-8 bytes / 4)`. It is deterministic local accounting, not provider tokenization or billing data. The default run uses `read-large` and `terminal-noise`; `--scenario` selects a fixture from `benchmarks/fixtures/`.

Reports include prompt digests, commit and environment metadata, working-tree provenance, and a `local-replay` measurement declaration. A fact found only in an artifact is recoverable but is not model-visible inline context.

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

The CLI route removes the MCP schema/call overhead for classified literal reads and produced a positive saving on this fixture. The earlier MCP route remains functionally valid but negative here. Reports: `live-claude-e2e.json`, `live-codex-tools.json`, and `live-codex-cli-tools.json` in the ignored `benchmarks/results/` directory; the CLI report was generated from the current dirty worktree and its evidence is not a release benchmark.

Single-cycle Codex aggregate estimate on a clean worktree: built-in shell twice → Sando CLI plus bounded `sando_exec`, 64,771 → 63,066 input tokens, saved 1,705 (2.63%); all quality gates passed. This is an estimate, not a stable total: use a multi-cycle campaign for a representative percentage.
