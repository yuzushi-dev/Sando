# V2 benchmark results — 2026-09-30

## Corrected collection — complete

The separately authorized corrected collection completed **100/100 attempts**:
control **50/50 passed**, Sando apply **50/50 passed**. All ten tasks passed
5/5 in each arm. The frozen operational regression gate passes, with no
observed drop in verified completions. This is a result on these synthetic
tasks, not a statistical equivalence claim or proof of general quality.

Collection ran from 18:29:27 to 19:07:22 UTC (20:29:27–21:07:22 Europe/Rome).
It used the same frozen v2 manifest and corrected collector, without retries
or mixing the earlier cohort. All processes completed with exit status zero,
all protected-file checks passed, and both collection locks were released.

| Metric, summed over 50 runs per arm | Control | Sando apply |
| --- | ---: | ---: |
| Verified completions | 50 | 50 |
| Input tokens, including cached input | 3,080,362 | 3,059,147 |
| Cached input tokens | 2,774,016 | 2,748,544 |
| Uncached input tokens, by subtraction | 306,346 | 310,603 |
| Output tokens | 25,867 | 25,377 |
| Tool calls | 191 | 203 |
| Explicit artifact retrievals | 0 | 0 |
| Summed attempt duration, milliseconds | 2,276,280 | 2,225,082 |

Input tokens were 0.69% lower with Sando, while uncached input was 1.39%
higher and tool calls were 6.28% higher. Summed attempt duration was 2.25%
lower; it is not collection wall time because attempts ran concurrently.
These descriptive totals do not establish a meaningful efficiency improvement
or monetary savings. Both arms reported zero cache-write input tokens.

Sando interception was exercised: 172 pre-tool events, 203 post-tool events
and 203 consumed rewritten commands. Control reported zero Sando hook events.
No explicit artifact retrieval was recorded, so this collection does not
demonstrate the efficiency of that recovery path. The evidence task's verified
answers still met its complete-source-line criteria.

All attempts requested `gpt-6.1-sol` with low reasoning. Apply observed that
model in all 50 runs; control did not expose an observed model identifier.
No model substitution was detected by the runner. USD cost and cost per
successful completion remain unknown under the authenticated subscription;
no API fallback was used and the monetary-comparison gate is incomplete.
Reported weekly quota usage was 80% before and 81% after; this coarse account
reading cannot attribute exact consumption to the benchmark.

Integrity verification covered 100 evidence metadata records, 40 retained
files (9,821 bytes), hashes, private permissions, frozen source receipt and
archive, exact 10×5×2 coverage, and the immutable earlier cohort. No evidence
file was truncated and no evidence overflow occurred.

Corrected artifacts under `packages/sando/benchmarks/results/`:

- `sando-v2-corrected-events.jsonl` and `sando-v2-corrected-evidence/`.
- `sando-v2-corrected-source.tar.gz` and `sando-v2-corrected-source-receipt.json`.
- `sando-v2-corrected-summary.json`: verified quality, accounting, usage and provenance.
- `sando-v2-corrected-quota-after.json`: safe account quota reading.

## Earlier collection — invalid partial

The authorized 100-attempt collection stopped after 89 completed attempts:
80 recorded passes and nine recorded failures. Eleven attempts were never
scheduled. This collection is invalid for quality comparison; the regression
gate is not evaluated and no savings claim follows from these results.

All nine failures concern criterion 2 of `reconcile-documentation`. The grader
incorrectly rejected reads of explicitly declared protected files, including
the required check of the unchanged `CHANGELOG.md`. Both protected-file
checksum checks passed in these attempts. Control completed five repetitions
and apply four; neither arm reached `fix-window-calculation`.

The corrected grader permits checks of the exact declared protected path while
continuing to reject differently named hardlink aliases. Protected-file
retention exclusions and symlink checks remain in force. Regression tests
cover the frozen documentation fixture and alias rejection. Fresh verification:
31 runner tests; 615 package and 124 bundle tests passed, with 10 optional
backend skips and zero failures. Runner syntax checks passed.

The original ledger, frozen manifest, collector source archive and evidence
remain unchanged. No attempt was retried or regraded. All 89 evidence metadata
records and 39 retained files (9,442 bytes) passed hash and permission checks.
The collector drained active children and released its lock before the fix.

Artifacts under `packages/sando/benchmarks/results/`:

- `sando-v2-events.jsonl`: original native attempt records.
- `sando-v2-evidence/`: private bounded evidence.
- `sando-v2-source.tar.gz` and `sando-v2-source-receipt.json`: original collector provenance.
- `sando-v2-interrupted-summary.json`: coverage, invalidation reason and immutable artifact hashes.

USD consumption is unknown under the existing Codex subscription. The separately authorized homogeneous benchmark is documented above.
This earlier ledger remains invalid and was not resumed or regraded.
