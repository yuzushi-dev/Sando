<p align="center">
  <img src="assets/sando-mark.png" alt="Sando logo" width="96">
</p>

# Sando

Dependency-free Node 22 tooling for preparing large tool output for Claude Code and Codex.

Sando bounds inline output, preserves a redacted artifact, and records savings metrics. It does not claim provider-token savings without provider counters.

## Install

Requires Node `22.22.x`.

```sh
git clone https://github.com/yuzushi-dev/Sando.git
cd Sando
npm test
```

No npm package is published yet.

Claude Code:

```sh
claude --plugin-dir "$PWD/adapters/claude/sando"
```

The plugin observes by default. Use `SANDO_MODE=apply` to enable Claude output replacement. See [`adapters/claude/sando/README.md`](adapters/claude/sando/README.md).

Codex: load the bundle in [`plugins/sando`](plugins/sando/README.md). Its `PostToolUse` hook is observational; effective preparation is exposed through MCP.

## Benchmark

Run the deterministic, provider-free benchmark:

```sh
npm run benchmark:local -- --scenario terminal-noise --repetitions 5
```

It compares the raw fixture with Sando using a reproducible local estimate (`ceil(UTF-8 bytes / 4)`), checks required facts, artifact recovery, quality, and secret leaks.

Example from this checkout:

```text
baseline: 4515 tokens
optimized: 1032 tokens
estimated saved: 77.14%
quality: 100%
```

These are local estimates, not billing data. Provider-reported savings are recorded only when paired baseline/optimized counters are available.

Live benchmarks consume quota and require explicit confirmation:

```sh
npm run benchmark:live -- --host claude --model sonnet \
  --unlimited-budget \
  --claude-plugin-dir adapters/claude/sando --confirm-cost
```

Live runs are prompt-level A/B measurements; they do not exercise a transparent Codex rewrite or Claude `PostToolUse`. See [`benchmarks/README.md`](benchmarks/README.md) for report fields and host details.

## Development

```sh
npm test
npm run check
```
