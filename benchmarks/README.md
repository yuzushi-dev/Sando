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
