# Luna recovery benchmark — ten pairs, 2026-10-01

The retrieval counter is fixed and the requested ten NEW local pairs are complete: **20/20 sessions passed**, control 10/10 and Sando 10/10. All sessions used native Codex 0.159.2, `gpt-6-luna`, low reasoning, workspace-write and no model/API fallback. Each session has six turns: 120 user turns and 436 observed model requests overall. Run: 07:44:07–08:13:37 UTC, with alternating pair order.

The predeclared economic screen **failed** because aggregate counterfactual Standard API cost fell only **0.19%**, below the required 10%. Quality did not regress on the existing checks. This cohort does not demonstrate a useful cost reduction on the deliberately exhaustive log task.

| Metric | Control | Sando |
| --- | ---: | ---: |
| Verified sessions | 10/10 | 10/10 |
| Input tokens | 6,298,754 | 6,253,330 |
| Cache-read input | 5,921,024 | 5,879,552 |
| Non-cached input | 377,730 | 373,778 |
| Output tokens, including reasoning | 23,939 | 25,144 |
| Cache-read share of input | 94.00% | 94.02% |
| Observed model requests | 219 | 217 |
| Tool calls | 157 | 170 |
| Actual artifact retrieval calls | 0 | 14 |
| Created artifacts | 0 | 10 |
| Sum of session durations | 767.56 s | 890.69 s |
| Counterfactual Standard API cost | $0.10895274 | $0.10874532 |

Sando input decreased 0.72%, non-cached input decreased 1.05%, output increased 5.03%, tool calls increased 8.28%, and summed session duration increased 16.04%. This duration is the sum of measured sessions, not total wall-clock time or isolated provider latency.

## Pair-level variation

Four pairs were cheaper with Sando and six were more expensive. The unweighted mean paired cost change was **+0.95%**, with a sample standard deviation of **13.77 percentage points**; the pooled aggregate change was −0.19%. These summarize different weights. The paired range was −19.61% to +24.07%. Ten pairs on one fixture are a descriptive screen, not statistical proof or a general workload comparison.

| Pair | Tool calls control / Sando | Estimated USD control / Sando | Sando cost change | Sando retrievals |
| --- | ---: | ---: | ---: | ---: |
| 1 | 17 / 17 | $0.01448862 / $0.01461718 | +0.89% | 5 |
| 2 | 15 / 16 | $0.00984858 / $0.01001700 | +1.71% | 1 |
| 3 | 15 / 21 | $0.01012118 / $0.01175984 | +16.19% | 1 |
| 4 | 20 / 15 | $0.01207832 / $0.00970922 | -19.61% | 1 |
| 5 | 15 / 17 | $0.01144282 / $0.01085024 | -5.18% | 1 |
| 6 | 16 / 18 | $0.00977760 / $0.01052934 | +7.69% | 1 |
| 7 | 15 / 15 | $0.01236460 / $0.01003030 | -18.88% | 1 |
| 8 | 16 / 18 | $0.00997676 / $0.01055940 | +5.84% | 1 |
| 9 | 13 / 19 | $0.00886820 / $0.01100292 | +24.07% | 1 |
| 10 | 15 / 14 | $0.00998606 / $0.00966988 | -3.17% | 1 |

The updated hint avoided the historical 49-call first-turn scan in these runs: Sando's first turns used 3–6 calls, while control used 2–6. That historical scan used Sol, so it is not another randomized arm of this Luna cohort. The broader economic result is near parity, not the 13.75% saving seen in the earlier single Sol pair.

## Counter correction

The collector now identifies actual artifact invocations with bare `sando`, absolute or quoted CLI paths, and the observed `/bin/bash -lc` wrapper. It excludes command text merely echoed or supplied to another program. The native total of 14 matches independent inspection of the command traces. One attempt prefixed the recovery command with `cat`; it is an ordinary failed command, not an artifact retrieval, and is correctly excluded from the retrieval count while its tool/usage costs remain included.

The regression test failed before the fix and passes afterwards. Historical ledgers and their raw zero counts were not rewritten. Model selection and pricing are now model-specific: the Luna protocol requires exactly one log task, ten repetitions per arm, 20 sessions, six turns each, and alternating order. A matching source receipt and the Luna pricing file are mandatory. The reporter rejects partial coverage as a complete result.

## Accounting and evidence limits

All 436 per-request usage records were priced with the frozen [GPT-6 Luna Standard profile](../../packages/sando/pricing/openai-gpt-6-luna-standard-2026-10-01.json), verified from [OpenAI's model documentation](https://developers.openai.com/api/docs/models/gpt-6-luna). Per million tokens, short-context rates are $0.10 fresh, $0.01 cache read, $0.125 cache write and $0.50 output. The long-context boundary is strictly above 272,000 input tokens; maximum observed request input was 45,474. Native cache-write input was reported zero and reasoning tokens are already part of output.

The API estimates assume Standard processing and no regional surcharge; observed native service tier was null. They reprice native usage rather than establish an API invoice, including how real API cache writes would behave. Actual subscription USD cost and attributable quota consumption remain unknown. Quota read 96% before and 97% after; account-wide, coarse metering and concurrent use prevent attribution. Provider caches were not reset between sessions.

The task still mandates inspection of the entire 720-line synthetic log. Full-content recovery can restore most information that compression initially omitted, so this workload places a limit on savings. The existing checks verify line/boundary facts, exact incident quotes, protected inputs and executable retry-policy behavior; they do not prove every source line was model-visible. Retained command outputs are bounded: 14 control outputs and 12 Sando outputs were truncated by the collector. No unpriced subagent calls were observed.

## Provenance and validation

The summary verified 97 frozen source files, runtime/native/manifest receipts, per-request reconciliation, and 140 private evidence files totaling 239,614 bytes, including hashes and permissions. Supervisor PID2425292 exited and both locks were released. All 22 preexisting telemetry files and earlier cohort ledgers remain unchanged.

Full validation before launch: package 668 passed with 10 optional Slice skips, bundles 125 passed; **793 passed, zero failed** overall. Syntax and diff checks passed. Independent prelaunch review checked model guards, profile selection and pricing hashes.

Results basename: `packages/sando/benchmarks/results/sando-recovery-luna-ten-pairs-20261001-*` (launcher, archive/receipt, events, evidence, quota events, quota-after and verified summary). Summary schema is `sando.cache-native-benchmark-summary.v1`, benchmark ID `sando-recovery-luna-v1`, complete coverage 20/20.

The initially launched Sol extension was stopped after two complete sessions and one interrupted session when the user specified Luna. It has an explicit cancelled-model-correction summary under `sando-recovery-ten-pairs-20261001-*`; none of its records enters this result. No push, publish, install or deployment occurred.

Rebuild the verified summary without model calls while the frozen sources still match (use their private archived snapshot after future code changes):

```sh
PATH=/home/gumi/.nvm/versions/node/v22.22.0/bin:/usr/bin:/bin node scripts/summarize-cache-native-benchmark.mjs \
  --manifest packages/sando/benchmarks/sando-recovery-luna-v1.json \
  --ledger packages/sando/benchmarks/results/sando-recovery-luna-ten-pairs-20261001-events.jsonl \
  --source-receipt packages/sando/benchmarks/results/sando-recovery-luna-ten-pairs-20261001-source-receipt.json \
  --expected-sessions 20 \
  --output /tmp/sando-luna-ten-pairs-review.json
```
