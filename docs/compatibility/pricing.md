# Versioned API cost estimates

## Supported scope and source

The initial profile is `openai-gpt-6.1-sol-standard-2026-09-30`, for
`openai-responses`, `gpt-6.1-sol`, Standard service and no regional surcharge.
It was verified on 2026-09-30 against [API pricing](https://developers.openai.com/api/docs/pricing),
[the model page](https://developers.openai.com/api/docs/models/gpt-6.1-sol), and
[prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching).

| USD per million tokens | Input <=272,000 | Input >272,000 |
|---|---:|---:|
| Fresh input | 2 | 4 |
| Cache read | 0.10 | 0.20 |
| Cache write | 2.50 | 5 |
| Output, including reasoning | 10 | 15 |

The tier uses total input, including cache, and applies to the entire request.
The output charge already includes reasoning. Cache writes replace the ordinary
input rate for those tokens; they are not an additional surcharge.

The pricing engine also supports the immutable profile
`openai-gpt-6-luna-standard-2026-10-01` for `gpt-6-luna`, verified on
2026-10-01 against [the Luna model page](https://developers.openai.com/api/docs/models/gpt-6-luna).

| Luna USD per million tokens | Input <=272,000 | Input >272,000 |
|---|---:|---:|
| Fresh input | 0.10 | 0.20 |
| Cache read | 0.01 | 0.02 |
| Cache write | 0.125 | 0.25 |
| Output, including reasoning | 0.50 | 0.75 |

Choose the matching profile explicitly for Luna estimates; the default profile
remains Sol. Other models, aliases, providers, tiers and regional contexts are unsupported.
The adapter maps the completed response's actual `service_tier: "default"`
to Standard, following the [processing-tier documentation](https://developers.openai.com/api/docs/guides/priority-processing).
An omitted or `auto` tier remains unknown; request preferences do not prove the
actual processing mode.

## Per-request input

Historical session/turn ledgers lack the needed request identity and billing
context. They remain readable and are never assigned this profile automatically.
The existing context-footprint proxy capture samples a session and is not a
complete per-request monetary ledger. No proxy is enabled by this implementation.

Use the exported adapter on a completed Responses object, explicitly supplying
regional context from your account/deployment configuration:

```js
import fs from 'node:fs';
import { buildApiUsageRequest } from 'sandoichi';

// response is a completed Responses API object obtained by your application.
const record = buildApiUsageRequest({
  response,
  regionalSurcharge: false,
  provenance: 'provider-response',
  sessionId: 'your-local-session',
});
fs.appendFileSync('/absolute/requests.jsonl', JSON.stringify(record) + '\n', { mode: 0o600 });
```

The adapter copies only accounting fields, hashes response/session IDs, and
retains counter sources and completeness. Pricing requires the documented
nested cache and reasoning fields; legacy transcript aliases alone are not
monetary evidence. It does not save messages, commands,
response output or arbitrary payload fields. Missing regional context remains
unknown. Synthetic examples must use `provenance: 'synthetic'`.

The `sando-api-usage-request/v1` record has a SHA256 `requestKey`, request `scope`,
`provenance`, `provider`, `model`, `service`, `regionalSurcharge`, normalized
`usage` and `usageQuality`. Prices are not stored in that input record. Optional
`providerReportedCostUsd` is carried separately; token usage alone does not
invent a provider bill. For paired summaries, supply a matching session ID and
explicit `arm: 'apply'` or `'control'` when building the record.

## CLI and library

```sh
npm run accounting -- --profile openai-gpt-6.1-sol-standard-2026-09-30 --requests /absolute/requests.jsonl --json
```

The distributed Codex/plugin CLI accepts the same flags after `accounting`.
Add `--path /absolute/provider-usage.json` to include legacy weighted and reported
accounting alongside `apiCost`. `--session ID` selects both sources explicitly.
`--profile` and `--requests` must be supplied together; unknown or incomplete
options fail visibly. All processing is local and read-only.

`estimateApiRequestCost` validates counters and metadata again rather than
trusting a historical `complete` assertion. `aggregateApiRequestCosts` prices
individual requests before summing. Provider and paired report helpers accept
optional `apiRequests` and `pricingProfile` together; the legacy weight defaults
remain unchanged.

Duplicate request identities are counted once, independently of JSON property
ordering. Conflicting revisions invalidate the identity. Unknown and incomplete
requests are counted as unpriced. The overall estimate stays null whenever any
request is unpriced, while `supportedEstimatedApiCostUsd` and the supported
request count remain available. Empty data is indeterminate, never a zero bill.
Aggregate token counts are checked for runtime-safe integer overflow.

Calculations use exact integer nanodollars, exposed as decimal strings in
`estimatedApiCostNanoUsd`; numeric USD fields are convenience representations. Provider-reported amounts
are accepted only from records marked `provider-response`, aggregated as integer
nanodollars, and must round-trip without alteration at nine decimal places.
Unsupported precision is marked invalid, while the token-based estimate remains
independent. Synthetic records cannot establish provider-reported money.
Only text presentation rounds to six decimal places. Reports identify profile,
profile hash, completeness and per-request provenance. The immutable profile
content is checked against a pinned canonical SHA256, so altered rates or dates
cannot be presented under its existing ID. Profile IDs are local
Sando identifiers, not model snapshots. Keep profiles immutable; a new listino
requires a new version. Existing reports must not be silently recomputed with a
replacement profile.

The reference fixture (100,000 input; 80,000 cache read; 10,000 cache write;
2,000 output including 1,500 reasoning) costs 0.073 USD. This is a synthetic
fixture and is not evidence of live provider usage or product savings.

Codex subscription consumption is not an API invoice. Mechanical output
reduction, provider-reported usage, actual reported amounts and API list-price
estimates remain separate. No end-to-end savings claim follows from these tests.
