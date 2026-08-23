<p align="center">
  <img src="assets/sando-mark.png" alt="Sando logo" width="96">
</p>

# Sando

Dependency-free Node 22 tooling for deterministic tool-output preparation around Claude Code and Codex.

Sando redacts common credential-shaped values, keeps a bounded inline view, preserves a complete redacted artifact, and records receipts and metrics. It does not call an LLM, access the network, or infer provider savings from local estimates.

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

The hook observes by default. Set `SANDO_MODE=apply` to enable Claude `PostToolUse` replacement for supported result shapes. The plugin also exposes the read-only `prepare_tool_output` MCP tool. See [`adapters/claude/sando/README.md`](adapters/claude/sando/README.md).

## Codex

Load the self-contained plugin bundle in [`plugins/sando`](plugins/sando/README.md). Its `PostToolUse` hook is observational; use the bundled `prepare_tool_output` MCP tool for effective preparation. Codex does not transparently replace an already-delivered tool result.

## Benchmarks

Run the provider-free deterministic replay:

```sh
npm run benchmark:local -- --scenario terminal-noise --repetitions 5
```

Local token counts use `ceil(UTF-8 bytes / 4)`. They are estimates, not provider tokenization or billing data.

Live A/B runs require `--confirm-cost`, consume provider quota, and measure prepared prompts rather than a host `PostToolUse` lifecycle. See [`benchmarks/README.md`](benchmarks/README.md) for commands, evidence, and limitations.

## Verify

```sh
npm test
npm run check
```
