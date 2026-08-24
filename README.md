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

The hook applies preparation by default for supported result shapes. Set `SANDO_MODE=observe` or `SANDO_OBSERVE_ONLY=1` to keep the original result while retaining local candidate metrics. The plugin also exposes the read-only `prepare_tool_output` MCP tool. See [`adapters/claude/sando/README.md`](adapters/claude/sando/README.md).

At `Stop`, the Claude adapter parses numeric usage from the transcript and appends it to `~/.local/state/sando/provider-usage.json`. The active workspace statusline wraps Honey and shows both values, for example `🍯 honey:full · 🥪 ~40 saved · 150in/7out · c30/w20`.

## Codex

Load the self-contained plugin bundle in [`plugins/sando`](plugins/sando/README.md). Its `PostToolUse` hook is observational. For proven literal reads/searches, `PreToolUse` rewrites the pending shell command to the bundled CLI, so no MCP round-trip is needed:

```sh
node plugins/sando/cli.mjs read -- path/to/file
node plugins/sando/cli.mjs grep -F -- pattern path/to/file
```

The hook resolves the installed bundle path automatically; the CLI keeps the Codex shell sandbox inherited by the calling tool. Codex does not transparently replace an already-delivered arbitrary built-in tool result.

For classified literal file reads/searches, the Codex `PreToolUse` gate performs that rewrite automatically. Pipelines, shell syntax, unsafe paths, and ambiguous commands remain allowed and are counted as bypasses. Explicit terminal coverage is available through `sando_exec` when Codex supplies managed restricted sandbox metadata; it fails closed otherwise.

At `Stop`, the plugin parses Codex transcript usage into the same provider ledger. Codex's installed TUI has no verified custom status item, so this workspace exposes the Sando line through tmux `status-right` (`scripts/sando-statusline.mjs`).

## Benchmarks

Run the provider-free deterministic replay:

```sh
npm run benchmark:local -- --scenario terminal-noise --repetitions 5
```

Local token counts use `ceil(UTF-8 bytes / 4)`. They are estimates, not provider tokenization or billing data.

The statusline prefixes local transform savings with `~`. Provider input/output/cache counters are reported values; an exact saved-token number requires paired baseline/optimized A/B evidence and is never inferred from one run.

Live A/B runs require `--confirm-cost`, consume provider quota, and measure prepared prompts rather than a host `PostToolUse` lifecycle. Observational hook metrics are local candidate estimates, not provider savings. See [`benchmarks/README.md`](benchmarks/README.md) for commands, evidence, and limitations.

## Verify

```sh
npm test
npm run check
```
