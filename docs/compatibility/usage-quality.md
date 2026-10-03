# Responses usage quality (S2)

The shared `responses-usage.mjs` normalizer accepts nested Responses counters and
legacy aliases. Nested fields take precedence only when all supplied aliases
agree; conflicts invalidate the record. Diagnostics retain field identifiers and
error codes, never arbitrary payload contents.

`usageQuality` uses `sando-usage-quality/v1` and distinguishes `complete`,
`incomplete`, and `invalid`. `sources` identifies observed fields; `missing`
identifies absent counters. Legacy reports still receive zero defaults for absent
optional counters, but those zeros are not observations and must not establish
eligibility for a monetary estimate. A complete record establishes counter
completeness only, not model, service tier, price or request provenance.

Capture records identify scope as `request`. Codex transcript records identify
`turn` or `last-usage`; these scopes cannot be treated as individual API requests
without a version-specific, verified adapter. Cumulative-only events are rejected
as `unsupported`; no deltas are inferred. Exact normalized event identities are
deduplicated. Conflicting revisions with the same stable event ID are excluded
and diagnosed, rather than summed or silently replaced. Distinct events with
equal counts remain distinct. Generic `info.usage` fields are unsupported.
Transcript provenance remains explicitly `unverified` until supported by
versioned client captures; timestamp-based legacy entries are not request proof.

Invalid records yield null usage in capture. Stable conflicting revisions are
also reconciled during collection: prior stored observations are retained with
`invalid` quality and excluded from aggregates. Their identity is a SHA256 digest;
no raw event identifier is stored in diagnostics. Transcript parsing omits invalid
records and supports an `onDiagnostic` callback; the collector returns a
`diagnostics` array. Valid transcript records retain their quality metadata in
local storage. The existing Stop hook does not persist the collector diagnostics;
absence of transcript records is not evidence of complete coverage. Historical
records without quality metadata remain readable and have unknown completeness.

Counters must be nonnegative safe integers. Cache reads plus cache writes cannot
exceed input, reasoning cannot exceed output, and an observed total must equal
input plus output within the safe integer range. Numeric strings, null, fractional
values and overflow are rejected.

The synthetic regression fixture has input 100,000, cache reads 80,000, cache
writes 10,000 and output 2,000 (reasoning 1,500). The normalized fresh input is
10,000. This is a fixture, not a provider observation. Pricing and changes to the
normalized accounting weights are outside S1/S2.

Reports expose counts of complete, incomplete, historical and unverified-scope
records, plus the number of invalid observations excluded from aggregates. Existing weighted units remain legacy estimates. Aggregate arithmetic
is still the legacy implementation; S3 must add checked aggregate arithmetic
and gate monetary estimates on verified request scope and complete counters.
