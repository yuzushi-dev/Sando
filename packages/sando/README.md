# Sando core

Dependency-free ESM for deterministic tool-output preparation and local savings metrics on Node 22. It does not call an LLM, access the network, or modify the bounded runtime.

## Stable benchmark API

```js
import { estimateTokens, optimizeToolOutput } from './packages/sando/index.mjs';

const result = optimizeToolOutput({
  toolName: 'Read',
  output,
  cwd: process.cwd(),
  policy: {
    mode: 'apply',
    maxInlineBytes: 4096,
    maxArtifactBytes: 65536,
    redact: true,
  },
});
```

`optimizeToolOutput({ toolName, output, cwd, policy })` returns `{ inline, artifact?, stats }`. `artifact.content` is a redacted, byte-bounded payload for the caller to persist; `artifact.ref` is content-addressed. The core itself performs no write. Inputs larger than both limits produce a truncated artifact and set `artifact.truncated`.

`policy` is optional. Defaults are the values above. `mode` accepts `apply`, `dry-run`, or `observe`; it is recorded for experiment attribution and does not change the deterministic candidate. Unknown fields, invalid modes, and out-of-range byte limits are rejected.

`estimateTokens(text)` returns `ceil(UTF-8 bytes / 4)`. It is a deterministic estimate for A/B comparisons, not provider tokenization or billable usage. `stats` reports exact byte counts and these estimates; it never reports or infers token savings.

Additional exports are `normalizeEvent`, `normalizePolicy`, and `createReceipt`. Receipts contain digests and deterministic stats, not raw output.

## Savings metrics

PostToolUse hooks persist one redacted numeric record per event. The default file is
`$XDG_STATE_HOME/sando/metrics.json`, or
`~/.local/state/sando/metrics.json`; set `SANDO_METRICS_PATH` to an
absolute path to override it. Directories are `0700`, the file is `0600`, and
writes use a lock plus temporary-file rename.

Run the report from this package:

```sh
node packages/sando/src/metrics-cli.mjs
node packages/sando/src/metrics-cli.mjs --json
```

The JSON schema is `sando-report/v1` and includes `currentSession`,
`averagePerSession`, `cumulative`, and `periods.daily|weekly|monthly`.
`estimatedTransformSavingsTokens` is `ceil(UTF-8 input bytes / 4) -
ceil(UTF-8 inline bytes / 4)` and is never provider usage. A
`providerReportedSavingsTokens` value appears only when an event supplies paired
provider counters (`baselineInputTokens` and `optimizedInputTokens`); otherwise
it is `null`. Repeated event IDs are ignored; events without IDs are keyed by
their receipt digest. Session averages group by host plus session ID, with one
unknown group per host when the host supplies no session ID.

The state timezone is fixed when the file is first created. Daily periods use
that timezone's calendar date; weekly periods are Monday-Sunday ISO weeks; and
monthly periods use that timezone's calendar month. Empty reports return zero
estimates and `null` provider savings.

```sh
node --test packages/sando/tests/*.test.mjs
```
