# Failure analysis — 2026-09-30

The operational score remains unchanged: Sando 38/50, control 47/50. The
100-attempt ledger remains immutable. This audit separates grading ambiguity,
launcher interruptions, and a reproduced output-contract defect. The aggregate
score is not evidence of an 18-point causal difference in semantic quality.

## Classification of the 15 failures

| Class | Sando | Control | What the evidence establishes |
|---|---:|---:|---|
| Outer launcher interruption | 4 | 0 | No verified task result; not model-quality evidence |
| Log report literals | 4 | 2 | Missing exact `retry=2` and/or `005`; semantic answer unavailable |
| Artifact citation literals | 2 | 1 | All three required facts present; missing exact `line 2/4/6` |
| Secret redaction | 2 | 0 | All three synthetic secret values still present in the output file |
| **Total** | **12** | **3** | **11 verified check failures, 4 interrupted attempts** |

Interrupted Sando runs: `preserve-argv` repetitions 3/4 and
`fix-window-calculation` repetitions 4/5. Their zero duration/tool-count fields
are placeholders; final metrics are unavailable. The outer 15-minute terminal
limit was a launch error. These runs are retained and never silently repeated.

## Grader ambiguity: nine runs

The log prompt requires the request, exact error code, preceding retry count,
and matching line numbers. It does not require the strings `retry=2` or `005`.
A local golden report containing:

> Request req-17 stopped the worker with E_PAYMENT_LOCKED at line 5.
> The preceding retry count was 2, shown on line 4.

passes the two fact identifiers and fails both literal checks. This is a
reproducible false-negative of the grader, not proof that the six historical
log answers were correct. Those answer files were deleted.

The artifact prompt asks for each exact source line. This correct response
passes all three facts but fails all three citation checks:

```text
Deployment target:
> 2 target=staging-eu
Failed check:
> 4 check=database-migrations status=failed
Rollback revision:
> 6 rollback_revision=7fa21c9
```

All three historical artifact failures passed their substantive fact checks.
The grader uses case-sensitive `String.includes`, requiring `line 2`, `line 4`,
and `line 6`, although those words are absent from the original source lines.

Retained local read, `cat`, and grep outputs preserve every required log and
artifact value. The retained files do not establish the full routed command
surface or bounded `sed` provenance.
No deterministic information loss was reproduced on these fixtures. The
historical commands and final answer text were not retained, so neither
correctness nor Sando-caused omission can be assigned to the nine ambiguous
cases. They are not automatically regraded.

Durable golden proof: [grader-proof.json](evidence/2026-09-30-failures/grader-proof.json).
Additional temporary local output:
`/tmp/sando-failure-repro.ire61B`. Reproduce the golden tests by writing the
texts above to the named result files, loading the frozen task's
`successCriteria`, and invoking `evaluateSuccessCriteria` exported by
`scripts/run-sando-benchmark.mjs`.

## Redaction contract defect: reproduced

The two historical redaction failures had check vector
`[false, true, false, false, false]`: the completion event survived, the
required placeholder was absent, and all three synthetic secret values
survived in `sanitized.log`. Protected `raw.log` was unchanged. This is a
substantive task failure rather than a citation-format issue.

The deterministic component behavior is:

1. The fixture's `raw.log` contains three synthetic credential values.
2. Sando's read/exec output replaces those values with `[REDACTED]` before
   sending text to the model.
3. Filesystem operations still use the original file bytes. `cp raw.log
   sanitized.log` copies the three original values.
4. Reading the copied file through Sando again displays placeholders, so the
   transformed view can conceal the failed on-disk redaction.

The implementation applies redaction in `packages/sando/src/core.mjs:368-375`
and records its count in internal stats at lines 471-489. The Codex bundle's
`cli.mjs:70-93` executes the original command before optimizing its output.
`cli.mjs:49-53` renders inline text without exposing the redaction count;
`session-start.mjs` supplies no notice that displayed placeholders need not
exist in the source file. The model cannot reliably distinguish file bytes
from substitutions applied only to their display.

### Two targeted authenticated diagnostics

The operator reports running these additional probes with the existing Codex
subscription, native 0.159.2, `gpt-6.1-sol`, low effort, and the frozen redaction
prompt/fixture. The retained summary does not independently attest that runtime
configuration or preserve the exact prompt. These are diagnostic evidence
outside the original 100 attempts, not replacements or a statistical replication.

| Probe | Observed command path | Verified output |
|---|---|---|
| Sando | Reads three placeholders; `python` attempt exits 127; then `cp raw.log sanitized.log` and `cmp` | Same bytes as raw fixture; three synthetic secrets, no placeholders; all original redaction failures reproduced |
| Control | Reads original values; same `python` error; retries with `python3` | Three placeholders, no synthetic secret values; all checks pass |

The Sando model explicitly stated that all values were already `[REDACTED]`
and preserved the contents. The missing `python` executable occurred in both
arms; it is not by itself an explanation for the differential result. The
Sando fallback acted on the incorrect belief induced by the transformed view.

The mechanism is **demonstrated in the diagnostic**. Whether either historical
failure used these exact commands remains **unverified**, because their traces
were not retained. No claim is made about real user credentials: all test
values and files were synthetic.

The durable, authentication-free [diagnostic summary](evidence/2026-09-30-failures/redaction-diagnostic-summary.json)
retains check vectors, output hashes/counts, and command hashes. Detailed
private traces are temporary and may disappear on cleanup; they are at
`/tmp/sando-redaction-native-diagnostic-5z1DtO` (directory 0700, files 0600).
Local component proof: `/tmp/sando-redaction-analysis-tUXJHs/evidence.json`.
No authentication fields or user-repository payloads are part of this report.

## Minimum corrections before another quality comparison

- Make display-time redaction explicit to the model, including that the
  original file remains unchanged. Preserve secret masking.
- Verify on-disk sanitization with programmatic checks returning safe counts
  or booleans, rather than another already-redacted display of the file.
- Replace underspecified literal citation checks with a frozen structured
  answer contract or validators accepting equivalent correct citations;
  validate them against correct and incorrect golden answers before use.
- Retain synthetic final artifacts and bounded diagnostic traces for future
  failure analysis. Launch long experiments persistently and supervise them
  through the ledger.

No production behavior, frozen criteria, historic outcomes, or prices were
changed by this analysis. API cost and monetary savings remain indeterminate.
The evidence supports fixing the redaction display contract and evaluation
pipeline before interpreting another aggregate quality comparison.
