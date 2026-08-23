# Sando benchmarks

The local benchmark is provider-free and deterministic. It replays identical
fixtures through a raw baseline and the optimizer, then reports paired inline
token estimates, complete artifact bytes, required fact presence,
model-visible quality, resolvability, and secret leaks. The estimate is
`ceil(UTF-8 bytes / 4)`; it is not a provider usage counter.

Reports include prompt digests, commit/environment metadata, and an explicit
`local-replay` measurement declaration. A fact found only in an artifact is
recoverable but is not counted as model-visible inline context.
Dirty runs include a `diffDigest`; non-Git or unreadable provenance is marked
`unknown` instead of being reported as reproducible.

Only the `tool-suite` fixture annotates required facts with `head`, `middle`,
and `tail` locations across Read, Grep, git, npm, and cargo-like outputs.
`read-large` and `terminal-noise` use unlocated string facts. Reports check
each fact value and emit `inline`, `artifact`, `modelVisible`, and `recoverable`;
the location label is fixture input, not a report field.

Run after the core scaffold exists:

```sh
npm run benchmark:local
node benchmarks/run-local.mjs --scenario terminal-noise --repetitions 5
```

A provider run records prompt digest, redacted args/stdout/stderr, commit,
timestamp, environment, client version, resolved model when present, and
reported usage. It is a separate gated operation because it can consume quota.

For Claude, effective input is normalized as
`input_tokens + cache_creation_input_tokens + cache_read_input_tokens`, because
the provider reports those counters separately. Codex's `input_tokens` is kept
as reported and `cached_input_tokens` is recorded separately.

The live command requires an explicit `--confirm-cost`. Claude can load the
local plugin with `--claude-plugin-dir`; the current live harness remains a
`prompt-level` A/B even when that directory is supplied because it disables
tools and does not exercise a host PostToolUse lifecycle. Codex's provider
measurement is also prompt-level; its feedback fallback is not transparent
rewrite. No global installation is performed by this repository.

There is no no-cost end-to-end host measurement. The exact paid commands below
are the closest probes; they remain prompt-level because the runner disables
tools and supplies prepared context, so Claude cannot exercise `PostToolUse`.
Codex's supported hook path is observational and its feedback fallback does not
rewrite delivered output. Do not run without quota approval.

```sh
npm run benchmark:live -- --host claude --model sonnet --max-budget-usd 0.25 \
  --claude-plugin-dir adapters/claude/sando --confirm-cost
npm run benchmark:live -- --host codex --scenario terminal-noise --confirm-cost
```
