<p align="center">
  <img src="assets/sando-mark.png" alt="Sando logo" width="96">
</p>

# Sando

Sando cuts what Claude Code and Codex charge you to re-read their own output. It redacts secrets, caps oversized tool results, and, if you turn it on, trims request history before it's sent, all without calling an LLM itself.

## Measured savings

**45.7% fewer input tokens, best case.** Measured against the real Anthropic API (provider-billed, not estimated), median of 5 live runs. Codex on the same test: 13.9%. Run it yourself: `benchmarks/live/proxy-e2e-run.mjs`.

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

Full numbers and methodology: [`benchmarks/README.md`](benchmarks/README.md).

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

Redacts and bounds tool output by default. Set `SANDO_MODE=observe` to keep the original output and just collect metrics. Details: [`adapters/claude/sando/README.md`](adapters/claude/sando/README.md).

## Codex

```sh
node plugins/sando/cli.mjs read -- path/to/file
node plugins/sando/cli.mjs grep -F -- pattern path/to/file
```

Same idea, adapted to Codex's hooks and sandbox. Details: [`plugins/sando/README.md`](plugins/sando/README.md).

## Provider proxy (optional)

The only Sando path that can shrink history already sent to the model:

```sh
SANDO_UPSTREAM_URL=https://api.anthropic.com SANDO_PROXY_PORT=8787 npm run proxy
ANTHROPIC_BASE_URL=http://127.0.0.1:8787 claude --plugin-dir "$PWD/adapters/claude/sando"
```

Deterministic, no LLM calls, streams through unchanged. It skips any rewrite that would cost more than it saves, so a warm prompt cache stays warm. Setup for Codex, tuning knobs, and the shadow-only semantic layer: [`packages/sando/README.md`](packages/sando/README.md).

## Benchmarks

```sh
npm run benchmark:local -- --scenario terminal-noise --repetitions 5
```

Local counts are `bytes/4` estimates, not provider billing. See [`benchmarks/README.md`](benchmarks/README.md) for live vs. local runs, evidence, and limits.

## Verify

```sh
npm test
npm run check
```
