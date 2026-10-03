# Redaction-notice diagnostic

Status: **completed — four verified successes**. This is a separately labeled native diagnostic, not a continuation or regrading of `sando-v1` and not a substitute for a future `sando-v2` collection.

The frozen manifest is [`redaction-notice-diagnostic-20260930.json`](../../packages/sando/benchmarks/redaction-notice-diagnostic-20260930.json), SHA-256 `789bc7d75ca0caa29cbab0e8c6ab95bf466f86b32634f97bad98946f4cdaadc2`. It copies the original `sando-v1` `redact-secrets` prompt, fixture, protected path, shared instructions, arms, and success criteria byte-for-byte. It requests Codex CLI 0.159.2 with `gpt-6.1-sol`, low reasoning effort, workspace-write sandboxing, approval policy `never`, and ChatGPT subscription authentication. Metered API fallback is forbidden.

The diagnostic predeclares two pairs and four runs. Pair one runs control then apply; pair two runs apply then control. The existing success criteria are retained unchanged, so this adds no grading rule. Results are diagnostic observations and are not directly comparable to either benchmark suite.

Evidence uses the `sando-v2` protocol unchanged: only declared synthetic outputs, verification records, and bounded redacted diagnostics are retained. Caps are 64 KiB per file, 256 KiB per attempt, and 32 MiB total. Protected fixtures, raw client streams, environment variables, and authentication material remain excluded. Subscription consumption has no request-level USD meter; monetary fields stay unknown, and observed usage must not be converted using API prices.

Inspect the derived four-run plan without model calls:

```sh
node scripts/run-sando-benchmark.mjs \
  --manifest packages/sando/benchmarks/redaction-notice-diagnostic-20260930.json
```

After checking remaining subscription quota, the prepared native invocation is:

```sh
node scripts/run-sando-benchmark.mjs \
  --manifest packages/sando/benchmarks/redaction-notice-diagnostic-20260930.json \
  --run
```

The native account check at 2026-09-30 15:30 UTC reported ordinary usage allowed and 73% of the primary subscription window used. The credit balance was zero, no API fallback is allowed, and measurable USD cost remains unknown. Check the quota again immediately before starting if execution is delayed.

Do not use a metered API fallback. If the apply arm repeats the copy-through failure, stop after this diagnostic and investigate the retained evidence before any broader collection.

## Observed result — 2026-09-30

Control passed 2/2 and apply passed 2/2. All four retained `sanitized.log` outputs contain three placeholders and none of the original synthetic values; their hashes, private permissions, original success checks, protected-file checks, and within-pair order were independently verified. Evidence is available for every attempt, with no overflow. This two-pair diagnostic does not establish general quality equivalence or monetary savings.

The [diagnostic summary](../../packages/sando/benchmarks/results/redaction-notice-diagnostic-20260930-summary.json) records the [separate event ledger](../../packages/sando/benchmarks/results/redaction-notice-diagnostic-20260930-events.jsonl), frozen source hash, timestamps, requested/observed models, observed usage, and evidence verification. Both apply runs observed `gpt-6.1-sol`; control observed model remains unknown. The last pre-launch quota check at 16:09:34 UTC allowed ordinary usage with 78% of the primary window consumed. USD remains unknown; no metered API fallback was used.

Local checks before collection passed: 613 package tests plus 124 bundle tests, 10 optional native Slice skips, zero failures; syntax, synthetic loopback, and diff checks passed. The historical v1 ledger and all 22 preexisting telemetry files remained unchanged. The frozen 100-run v2 collection has not started and requires a separate decision.
