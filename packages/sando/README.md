# Sando core

Dependency-free ESM for deterministic tool-output preparation and local savings metrics on Node 22. The core performs no writes, network access, or LLM calls.

## API

```js
import { estimateTokens, optimizeToolOutput } from './index.mjs';

const result = optimizeToolOutput({
  toolName: 'Read',
  output,
  cwd: process.cwd(),
  policy: {
    mode: 'apply',
    maxInlineBytes: 4096,
    maxColumns: 768,
    redact: true,
  },
});
```

`optimizeToolOutput({ toolName, output, cwd, policy })` returns `{ inline, artifact?, route, reason, stats }`.

- `output` may be text or a JSON value; JSON is serialized deterministically.
- Small output stays inline. Larger output gets a bounded head/tail view with middle elision and an optional complete redacted artifact.
- `artifact.content` is returned to the caller; the core does not persist it. `artifact.ref` is content-addressed.
- Common `Authorization`, API key, access-token, password, secret, and private-key fields are redacted by default.
- `mode` accepts `apply`, `dry-run`, or `observe`. It is recorded in `stats`; it does not change the deterministic candidate.
- `route` records the selected tool policy (`passthrough`, `structured`, `artifact`, or eligible `summary`). Routing metadata is not a claim that a host can intercept a built-in result.

`estimateTokens(text)` returns `ceil(UTF-8 bytes / 4)`. It is a deterministic local estimate for comparisons, not provider tokenization or billable usage. `stats` reports exact byte counts and local estimates; it never infers provider savings.

Hook sessions can set `SANDO_OBSERVE_ONLY=1` (also `true` or `yes`) to force observation even when `SANDO_MODE` or `SANDO_POLICY.mode` says `apply`. The hook then records the candidate estimate without replacing the host tool result.

Additional exports are `normalizeEvent`, `normalizePolicy`, and `createReceipt`. Receipts contain digests and deterministic stats, not raw output.

## Metrics

Hooks persist redacted numeric records at `$XDG_STATE_HOME/sando/metrics.json`, or `~/.local/state/sando/metrics.json` when `XDG_STATE_HOME` is unset. Set `SANDO_METRICS_PATH` to an absolute path to override it.

```sh
node packages/sando/src/metrics-cli.mjs
node packages/sando/src/metrics-cli.mjs --json
```

The JSON report is `sando-report/v1`. `estimatedTransformSavingsTokens` is based on the local byte estimate. `providerReportedSavingsTokens` is `null` unless paired provider counters are supplied.

`src/provider-ledger.mjs` is separate accounting infrastructure for provider prompt/output and cache-read/cache-write counters. It does not calculate savings or parse provider-native responses.

`src/provider-usage.mjs` is the persisted provider transcript ledger (`sando-provider-usage/v1`). It stores numeric Claude/Codex usage only, deduplicates repeated Stop hooks, and keeps provider input/output/cache counters separate from local transform estimates. The default file is `~/.local/state/sando/provider-usage.json`; override it with the absolute `SANDO_PROVIDER_USAGE_PATH`.

`src/statusline.mjs` renders `~estimated saved` separately from provider-reported `input/output/cache` counters. It returns a safe empty or stale state when the ledgers are missing or old.

`spikes/context-lifecycle/` and `spikes/provider-routing/` are experimental, host-independent prototypes; they are not wired into Claude Code or Codex.

## Test

```sh
node --test packages/sando/tests/*.test.mjs
```
