# Native cache-aware pilot — 2026-09-30

Six local Codex subscription sessions completed successfully: three control and three Sando, six user turns in the same thread per session. These are 36 user turns and 127 observed model requests, not 36 API calls. Execution used native Codex 0.159.2, GPT-6.1 Sol, low reasoning, workspace-write sandbox and no API fallback. Run: 20:21:33–20:35:35 UTC.

The result is **inconclusive-pilot**: one pair per scenario cannot establish general savings. The estimated aggregate counterfactual API cost decreased 15.75%, but the log scenario increased 14.86%, exceeding the predeclared 5% per-scenario ceiling. This does not satisfy the proposed operational screen, even before considering sample size.

| Metric | Control | Sando |
| --- | ---: | ---: |
| Verified sessions | 3/3 | 3/3 |
| Input tokens | 2,899,512 | 2,032,620 |
| Cache-read input | 2,756,864 | 1,904,768 |
| Non-cached input | 142,648 | 127,852 |
| Output tokens | 6,428 | 8,062 |
| Cache-read share of input | 95.08% | 93.71% |
| Observed model requests | 61 | 66 |
| Tool calls | 37 | 133 |
| Created artifacts | 0 | 4 |
| Explicit artifact retrievals | 0 | 0 |
| Sum of session durations | 365.19 s | 447.48 s |
| Hypothetical Standard API cost | $0.6252624 | $0.5268008 |

| Scenario | Estimated cost change with Sando | Quality |
| --- | ---: | --- |
| Noisy incident log | +14.86% | Both pass |
| Broad repository search | −37.49% | Both pass |
| Tabular test reconciliation | −20.12% | Both pass |

Input decreased 29.90%; non-cached input decreased 10.37%; output increased 25.42%. Tool calls rose from 37 to 133 and summed session duration rose 22.53%. In the log scenario, Sando used many partial source reads to satisfy the first-turn requirement to inspect the entire log: fewer total input tokens did not produce lower estimated cost. The [recovery investigation](log-recovery-investigation.md) identifies 47 bounded reads, including 12 duplicated windows, and verifies one-call artifact recovery offline. Artifact creation demonstrates that the compression path ran; explicit artifact recovery was not exercised. Source reads could recover omitted details.

## Accounting limits

The API figures are **counterfactual**, using the frozen GPT-6.1 Sol Standard profile: $2/M non-cached input, $0.10/M cache read and $10/M output, with exclusive cache-write accounting. All 127 request-level usage records were priced; maximum request input was 67,317 tokens, below the long-context threshold. Reasoning output is already included in output tokens.

Native service tier was null; Standard tier and no regional surcharge are hypothetical assumptions. Native Codex reported zero cache-write input tokens. Repricing this subscription usage does not establish what an actual API experiment would bill for cache writes. Subscription USD cost and attributable quota cost remain unknown. Account quota read 90% before and 92% after; concurrent account use and coarse percentages prevent attribution. No cold cache was forced.

Control evidence contains 11 collector-truncated outputs. Retained text and original byte counts are bounded diagnostic evidence, not a claim that every model-visible response was retained. No nested agents were observed.

## Integrity, correction and reproduction

The first pilot was stopped after three started sessions: two completed six turns and one was interrupted. Its first control passed the executable assertions but failed a literal grader because the prompt allowed prose where the grader required `incident=halt`. The original manifest, ledger, evidence and source archive remain separate and unchanged. No old result was regraded or mixed into this cohort. The corrected manifest states the required output format without supplying the derived answer; three offline oracle tests check correct solutions, wrong results and protected-file mutations.

The corrected report verified 91 frozen source files, manifest/source/native provenance, per-request usage reconciliation, and 42 retained evidence files (99,492 bytes), including hashes and private permissions. The collector exited and released both locks. All 22 preexisting telemetry hashes remain unchanged.

Before launch, the full suite passed 779 tests with 10 optional Slice skips; the corrected oracle and fixture tests then passed 8/8, including three additional oracle tests. Final collector/reporter/fixture/oracle checks passed 43/43. Loopback verification and `git diff --check` passed. No publish, push, deploy or installation occurred.

Private local results use `packages/sando/benchmarks/results/sando-cache-v1-corrected-*`: events ledger, evidence directory, source archive/receipt, pilot summary and quota-after receipt. The invalid original pilot uses `sando-cache-v1-*` and has an explicit invalid-pilot summary.

Rebuild the summary without model calls from the frozen source snapshot (the current checkout has since changed its recovery hint, so the source guard intentionally rejects it). Restore archived sources in a separate private checkout with the corresponding private results and receipt/archive paths before running:

```sh
PATH=/home/gumi/.nvm/versions/node/v22.22.0/bin:/usr/bin:/bin node scripts/summarize-cache-native-benchmark.mjs \
  --manifest packages/sando/benchmarks/sando-cache-v1-corrected.json \
  --ledger packages/sando/benchmarks/results/sando-cache-v1-corrected-events.jsonl \
  --source-receipt packages/sando/benchmarks/results/sando-cache-v1-corrected-source-receipt.json \
  --expected-sessions 6 \
  --output /tmp/sando-cache-pilot-review.json
```

The larger 30-session screen has not run. The useful next investigation is why exact-citation recovery adds so many reads, before deciding whether to spend more subscription quota on repetitions.
