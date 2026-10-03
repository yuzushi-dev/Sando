# Implementation status — 2026-09-30

## Latest benchmark status

The separately authorized corrected v2 collection completed all 100 native
attempts: control **50/50**, Sando apply **50/50**, with 5/5 for each task/arm.
The operational regression gate passes. Evidence, source provenance and exact
coverage are verified. USD cost remains unknown; observed token and duration
differences do not establish monetary savings. The earlier interrupted cohort
remains immutable and invalid. See [the collection report](benchmark-v2-results.md).
Fresh local verification before launch passed 739 tests with zero failures and
10 optional backend skips.

Authorized scope: S1–S4, followed by a 20 USD overall spending ceiling. The user
explicitly selected the existing authenticated Codex subscription instead of an
API key. Subscription usage must not be represented as an API invoice.

Worktree: `/home/gumi/Documenti/Sando`; branch
`work/codex-compat-cache-20260930`; checkout base
`0e523fdf754c7667d3593ced26a82dbdebf8113a` (older than the plan baseline).
The 22 preexisting telemetry changes remain byte-for-byte unchanged.
No commit, remote push, publication or deployment has been performed.

## Redaction and benchmark fixes — completed 2026-09-30

The authorized follow-up plan is implemented. Display-only masking is disclosed across CLI, hooks, MCP and artifact recovery; final delivered budgets, UTF-8 boundaries, receipts and recovery ranges are covered by local tests. Filesystem tests distinguish masked reads from actually sanitized files. The frozen v2 manifest requires complete source-line citations without changing historical v1 grading.

The runner now isolates manifests and outputs, retains bounded synthetic evidence with exact credential removal including rotations, fails closed on unavailable credential coverage, verifies executable/source provenance, locks collection paths, and preserves interrupted metrics as unknown. Resume never silently retries an interrupted run; owned descendants are terminated before verification and cleanup.

Fresh verification: **613 package + 124 bundle = 737 passed**, 10 skips for the optional native Slice backend, zero failures. Syntax, synthetic loopback and diff checks passed. A separately frozen native [redaction diagnostic](redaction-notice-diagnostic.md) passed control **2/2** and apply **2/2**, with all retained evidence verified. This small diagnostic supports the next experimental decision; it is not proof of general quality or savings. USD consumption remains unknown under the subscription. At this initial milestone the v2 collection had not yet started; its subsequent interrupted launch is documented above. No commit, push, installation, publication or deployment was performed.

The original telemetry baseline in `/tmp` was no longer present after session continuation. Its complete 22-file hash map was recovered from the pre-task Sando output artifact; all 22 files match. Historical v1 manifest and event ledger hashes remain unchanged.

## Implemented

- S1/S2: shared Responses normalization, explicit usage quality and provenance,
  safe counters, stable-identity deduplication and conflicting-revision quarantine.
- S3: pinned, versioned GPT-6.1 Sol Standard pricing; request-level short/long
  thresholds, exact integer accounting, separate reported costs and estimates,
  explicit exclusions for missing metadata or unsupported counters. CLI/library
  integration preserves existing normalized weights. See [pricing.md](pricing.md).
- S4 client contract: native Codex 0.159.2 consumes Sando's hook rewrite, handles
  delayed SSE without duplicate execution, starts/resumes, and denies real
  `PermissionRequest` calls through app-server. Exact hook hashes are trusted
  only in disposable configuration; `workspace-write` remains enforced.
  This uses a synthetic local provider, not authenticated provider evidence.
  See [codex.md](codex.md).
- S4 benchmark: ten concrete tasks, five repetitions per arm, counterbalanced
  schedule, frozen fixtures and verification criteria. Authenticated subscription
  execution finished with 100 retained scheduled attempts; results are recorded in
  [benchmark-results.md](benchmark-results.md).

## Benchmark outcome

Native Codex subscription, `gpt-6.1-sol`, low effort: control **47/50** verified
successes, Sando **38/50**. Four Sando attempts were interrupted by the outer
terminal's 15-minute timeout and retained as failed/unverified; they were not
rerun. Even independently of those interruptions, the frozen task gate failed:
log evidence 1/5 versus 3/5 and secret redaction 3/5 versus 5/5. These are results
of strict automated criteria, not a claim of general human quality equivalence.

API costs and cost per successful completion remain indeterminate under the
subscription. Cache-read totals are observed in the allowlisted usage records.
Cache-write totals are unavailable because the frozen runner missed Codex's
`cache_write_input_tokens` alias; the run is not backfilled. The frozen runner
is archived for reproducibility, and the alias was corrected and regression-tested
for future runs. Collected records remain unchanged. Four interrupted attempts have no observed final duration/tool counts:
their zero placeholders must not be interpreted as measurements. No positive
cost or overall performance claim is supported by this benchmark.

The subsequent [failure analysis](failure-analysis.md) identified nine ambiguous
literal-citation failures and reproduced a substantive display-time redaction
defect in one additional Sando diagnostic; its control passed. The original
score and ledger remain unchanged. Two historical redaction failures contained
all three synthetic secret values, but their exact command traces were not
retained. Display-only masking can make an agent copy an unsanitized file while
believing the displayed placeholders are its real contents. Production code was not changed during that analysis. The subsequent contract
fix and separately labeled diagnostic are reported above.

## Validation and remaining gates

Previous full run after the collector/accounting fixes: package 574 passed,
10 skipped; bundles 118 passed; zero failures (692 passed overall). The 10 skips require the optional
native Slice backend. Syntax and diff checks passed; all 22 original telemetry
hashes matched. The final independent review passed 19 focused benchmark tests
and verified ledger, archives, aggregates and limitations. The initial launch
through a 15-minute terminal wrapper was an orchestration error; persistent
launch instructions are now documented in [benchmark.md](benchmark.md).

An authenticated subscription probe passed using native Codex 0.159.2 and
`gpt-6.1-sol`: Sando's rewrite was consumed, the command executed once, and
the marker was written once. Usage counters were observed; API cost remains
unpriced. Historical Codex 0.153.4 is absent. Separate tool polling is untested because the
observed shell surface is synchronous. A ChatGPT subscription has no observed
API invoice: monetary comparisons require complete request-level accounting
metadata and cannot be inferred from token totals. No paid OpenAI API calls
have been made.

Use the native npm Codex directory first in PATH for bundle verification; the
machine-local wrapper otherwise fails to locate its vendored binary:

```sh
PATH=/home/gumi/.nvm/versions/node/v22.22.0/bin:/usr/bin:/bin npm test
npm run check
npm run verify:codex-compat:loopback
```

## Native cache-aware pilot

Six local subscription sessions (36 user turns, 127 observed model requests) passed all task checks. Aggregate hypothetical Standard API cost decreased 15.75%, but logs increased 14.86% and tool calls rose from 37 to 133. This is an inconclusive pilot, not a passed operational screen or demonstrated subscription saving. The initial invalid pilot is preserved separately. See [cache-native-benchmark-results.md](cache-native-benchmark-results.md). The proposed 30-session screen has not run.

## Recovery-hint focused trial — 2026-10-01

Two new native sessions on the unchanged log task passed. Updated Sando used 5 first-turn tool calls and 14 across six turns, compared with 49/58 in the historical pilot; the new control used 3/10. Two artifact commands were observed despite the collector regex reporting zero for absolute CLI paths. Counterfactual Standard API cost was 13.75% below the new control; subscription cost remains unknown and one pair cannot establish stable savings. See [focused native trial](recovery-hint-native-trial.md). Fix the absolute-path retrieval counter before broader artifact-use comparisons.

## Ten paired Luna sessions — 2026-10-01

Absolute-path artifact retrieval counting is fixed. The Luna cohort completed 20/20 sessions (control 10/10, Sando 10/10) using gpt-6-luna with low reasoning. Sando made 170 tool calls versus 157 for control, including 14 actual artifact retrievals. Counterfactual Luna Standard API cost decreased 0.19%, below the predeclared 10% screen. All quality checks passed; useful economic savings were not demonstrated on this full-inspection log task. The initial Sol extension was cancelled and retained separately. Validation: 793 tests passed, 10 optional tests skipped, zero failures. See [Luna ten-pair results](recovery-luna-ten-pairs-results.md).
