# Sando

Sando is a dependency-free Node 22 layer for deterministic tool-output preparation, standalone host adapters, and provider-free A/B benchmarks. It does not invoke an LLM, access the network, or claim provider-token savings.

## Layout

- `packages/sando/` — core API, metrics, MCP server, and tests.
- `plugins/sando/` — standalone plugin bundle.
- `adapters/claude/sando/` and `adapters/codex/sando/` — copied host bundles.
- `benchmarks/` — deterministic fixtures, replay, audit, and optional live harness.
- `spikes/` — routing and status-line experiments.

## Commands

```sh
npm test
npm run check
npm run benchmark:local
```

Live benchmarks require explicit host and cost confirmation; they are not part of `npm test`.

Runtime identifiers use `SANDO_*` environment variables, `sando-*` schemas, `sando:` artifact references, and `cwd/.sando/sando/artifacts` for bounded artifacts. Metrics default to `$XDG_STATE_HOME/sando/metrics.json` or `~/.local/state/sando/metrics.json`.
