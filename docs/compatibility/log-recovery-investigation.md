# Log recovery investigation — 2026-10-01

The corrected native pilot shows an avoidable recovery scan, not a broken line-range implementation. In the noisy-log scenario, the first user turn explicitly requested complete inspection of `logs/build.log` with `cat` and a large native output budget. Sando routed that command to `read`, returned a bounded head/tail preview, and printed an executable artifact-recovery command for lines 24–706.

The agent never invoked artifact recovery. Instead, it issued 47 bounded source reads: a sequential scan of 24–703 in 34 twenty-line windows, 704–706 once, and 12 repeated windows covering 244–483. Every returned range matches the requested source slice. The initial read, a repository/line-count command and those 47 reads account for all 49 first-turn tool calls. The whole six-turn session contains 58 calls.

| First-turn measurement | Control | Sando |
| --- | ---: | ---: |
| Tool calls | 3 | 49 |
| Observed model requests | 5 | 6 |
| Cumulative input tokens | 160,504 | 138,180 |
| Cache-read input tokens | 130,560 | 113,408 |
| Non-cached input tokens | 29,944 | 24,772 |
| Output tokens | 317 | 631 |

Tool calls are not synonymous with model requests: several commands can be produced in one request. Nor does a high call count prove greater total input than control. Even this first turn used less input with Sando. It does prove a wasteful recovery path: its 47 bounded reads returned 75,629 bytes, while the entire original log is 58,937 bytes. Including the initial preview (3,346 bytes) and line-count output (100 bytes), the retained, untruncated Sando command results total 79,075 bytes. Repeated commands and outputs also add conversation entries. The full-session counterfactual API cost was 14.86% higher with Sando; this trace alone cannot isolate which part caused that cost difference.

## Offline recovery proof

Using the identical protected fixture, the actual adapter read implementation, artifact persistence and actual artifact CLI, one `artifact get` request for lines 24–706 recovered all 683 omitted lines: 55,912 bytes, exact source equality, no truncation. The default 65,536-byte recovery limit suffices. No model call, subscription usage or paid API call was needed for this check.

The offline reproduction created a fresh private temporary workspace. Its generic read preview was 4,095 bytes; the archived native session preview was 3,346 bytes. These differ because the native pilot supplied its own runtime configuration. The evidence supports the recovery mechanism, not a claim that the new reproduction matches every native configuration detail.

## What the evidence supports

- The benchmark requirement to inspect the complete log was followed by an exhaustive scan. It is not representative of a task that only asks for the fatal event and its retry context.
- Sando offered a working bulk recovery command, but the observed sequence uses small source reads instead; no artifact-retrieval call was recorded.
- Twelve duplicate windows are established by the ledger. Their reason is unknown; no claim about model intent is warranted.
- A clearer recovery instruction could prevent this behavior, but no native trial has yet demonstrated that it changes the model's choice.

The earlier report described exact-citation reconstruction as the cause of the log overhead. The largest burst actually occurs in turn one, before the citation task: it reconstructs the mandated full inspection. Later citation work adds much less overhead.

## Minimum correction to evaluate

Preserve the old manifest and results. For a separately versioned experiment, distinguish task-directed investigation from deliberately exhaustive inspection. When exhaustive inspection is required and an artifact is offered, explicitly direct the agent to recover the omitted range once rather than reconstruct it with many source reads. For incident diagnosis, permit a targeted search plus surrounding lines. Use the same instructions in both arms and retain the code/citation quality checks.

A production recovery hint could make the choice clearer: “Need the omitted content? Run this recovery command once; it returns the requested range without recompression.” Any such wording change needs delivery-budget and executable-hint checks, followed by a separately authorized native trial to measure behavior. Increasing the general inline budget or automatically dumping every log would affect unrelated workloads and is not justified by this trace.

No production code, frozen benchmark input, original ledger or archive was modified during this investigation. Evidence source: `packages/sando/benchmarks/results/sando-cache-v1-corrected-events.jsonl`, run key `noisy-log-incident:1:apply`. Relevant implementation: `adapters/codex/sando/cli.mjs` read bounds and `adapters/codex/sando/lib/mcp-tools.mjs` line slicing before optimization. The current pilot and its aggregate limits remain in [cache-native-benchmark-results.md](cache-native-benchmark-results.md).

## Recovery hint implemented

On 2026-10-01 the Codex CLI recovery hint was updated to: “For omitted content, use this bounded recovery call before repeated small reads”. The existing executable command and range remain present. The hint is added during delivery transformation, so its bytes count against the final output cap. Tight-budget fallback and display-redaction notices retain their existing behavior.

A new CLI integration test reads a large log, checks the 4 KiB delivery budget, follows the printed artifact handle/range through the actual artifact CLI, and verifies exact untruncated recovery in one call. The preexisting output-order and tight-budget tests also pass. This checks correctness of the affordance; whether it reduces model tool calls remains unmeasured. No new native sessions were launched. Final validation: package 658 passed / 10 optional Slice skips; bundles 125 passed; zero failures (783 passes overall). Syntax and diff checks passed.

The historical pilot’s source archive, receipts, ledger and summary remain immutable. Its source guard will reject the changed current checkout; reproduction must use its archived source snapshot. A future native comparison requires a new source receipt and result basename.

## Focused native follow-up

A separately frozen two-session trial on 2026-10-01 observed artifact recovery with the updated hint: first-turn Sando tool calls 5 versus the historical 49; session calls 14 versus 58. Both new arms pass. The new pair estimates 13.75% lower counterfactual Standard API cost with Sando, but it is a single observation. The trace shows two actual artifact commands that the current regex counter misses for absolute CLI paths. See [focused native trial](recovery-hint-native-trial.md) for preserved raw counters, derived counts and limitations.
