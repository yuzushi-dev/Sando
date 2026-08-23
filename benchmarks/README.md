# Sando benchmarks

The local benchmark is provider-free and deterministic. It replays identical
fixtures through a raw baseline and the optimizer, then reports paired inline
token estimates, complete artifact bytes, location-aware fact presence,
model-visible quality, resolvability, and secret leaks. The estimate is
`ceil(UTF-8 bytes / 4)`; it is not a provider usage counter.

Reports include prompt digests, commit/environment metadata, and an explicit
`local-replay` measurement declaration. A fact found only in an artifact is
recoverable but is not counted as model-visible inline context.

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

Example (do not run without quota approval):

```sh
npm run benchmark:live -- --host claude --model sonnet --max-budget-usd 0.25 \
  --claude-plugin-dir adapters/claude/sando --confirm-cost
```
