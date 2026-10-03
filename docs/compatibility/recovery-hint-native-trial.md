# Recovery hint native trial — 2026-10-01

Two new local subscription sessions completed the unchanged noisy-log task: one control and one updated Sando, six turns each. Both pass all existing executable and output criteria. The updated first turn uses the printed artifact recovery command, replacing the previous exhaustive small-read scan.

| Metric | Previous Sando pilot | New control | New Sando |
| --- | ---: | ---: | ---: |
| First-turn tool calls | 49 | 3 | 5 |
| Full-session tool calls | 58 | 10 | 14 |
| Actual artifact commands in trace | 0 | 0 | 2 |
| Full-session model requests | 21 | 20 | 21 |
| Input tokens | 681,960 | 834,827 | 683,312 |
| Cache-read input | 624,640 | 797,312 | 652,416 |
| Non-cached input | 57,320 | 37,515 | 30,896 |
| Output tokens | 2,566 | 2,354 | 2,676 |
| Session duration | 162.49 s | 164.93 s | 145.17 s |
| Counterfactual Standard API cost | $0.2027640 | $0.1783012 | $0.1537936 |

The prior Sando column is a historical observation, not another randomized arm in this experiment. Native execution remains Codex 0.159.2, GPT-6.1 Sol low, workspace-write, no API fallback. The first-turn prompt still mandates complete log inspection; neither task nor success criteria were changed. Fresh private threads/workspaces were used; provider cache was observed rather than forced cold.

New Sando versus its new control: input −18.15%, non-cached input −17.64%, duration −11.98%, hypothetical Standard API cost −13.75%. It still used more tool calls (14 versus 10). Relative to the historical Sando trace, first-turn calls fell 49→5 and full-session calls 58→14. One pair and a historical comparison do not establish a stable improvement or isolate causality from model/cache variation. The useful behavioral observation is that artifact recovery was actually invoked.

## Recovery trace and measurement defect

The new first turn performs: initial Sando read, repository-rule search, artifact recovery for lines 23–706, another artifact recovery for 260–470, and a line-count/boundary command. There are no twenty-line source-read scans in this turn. The two recoveries use the absolute CLI path printed by Sando.

The collector's `artifactRetrievals` field incorrectly reports zero because its regex recognizes a literal `sando artifact get` token but misses the absolute `/.../bin/sando artifact get` command. Original native records are preserved. The focused summary reports both the raw collector count and `observedArtifactCommands=2`, manually checked against exact command strings. This is a newly established accounting defect to fix before broader artifact-use comparisons; no historical ledger was rewritten.

The two command results have original lengths 56,113 and 17,463 bytes; retained collector evidence is bounded/truncated. This does not establish that every source line was visible to the model. All existing quality checks pass, but they cannot prove exhaustive inspection of every line. The previous offline check established exact artifact recovery independently of native rendering.

## Provenance and limits

The separately frozen source receipt covers 92 files, including the focused two-session launcher. Session limit is exactly two; the full 30-session plan was not executed. Source and archive hashes, request-to-turn and turn-to-session usage totals were checked; 12 retained output files (3,607 bytes) match their hashes and private permissions. Both sessions contain six turns. The supervisor exited and released its locks.

Results basename: `packages/sando/benchmarks/results/sando-recovery-hint-20261001-*`: launcher, source archive/receipt, events, evidence, focused summary and quota-after receipt. This summary has its own `sando.recovery-hint-focused-summary.v1` schema; it is not the full six-session pilot report.

All 41 requests were below the long-context threshold, with native cache-write input reported zero. The API figure assumes Standard GPT-6.1 Sol pricing ($2/M fresh, $0.10/M cache read, $10/M output), no regional surcharge and the observed native usage. Native service tier is unknown. Actual subscription USD and attributable quota costs remain unknown. Account quota read 93% before and 94% after; no causal attribution follows from this coarse account metric.

The CLI change previously passed 783 tests with 10 optional Slice skips, plus syntax/diff checks. No new production changes were made during this run. Original pilot results and preexisting telemetry remain unchanged. No publish, push, installation or deployment occurred.
