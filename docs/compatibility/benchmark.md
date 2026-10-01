# Sando paired benchmark protocol

Status: **authorized for native subscription collection**. An initial receipt stopped before model execution because it incorrectly required API-key metering. The user then explicitly selected the authenticated Codex subscription path. A native Sando pilot passed with Codex CLI 0.159.2 and `gpt-6.1-sol`; the full frozen run is recorded separately in the results ledger. Nothing in installation, `postinstall`, `doctor`, or the offline test suite starts this benchmark.

The historical workload is [`packages/sando/benchmarks/sando-v1.json`](../../packages/sando/benchmarks/sando-v1.json). Its manifest, event ledger, evidence archives, and published score are immutable. The future workload is [`packages/sando/benchmarks/sando-v2.json`](../../packages/sando/benchmarks/sando-v2.json). It keeps the same ten synthetic tasks and counterbalanced 100-run schedule, but tightens two evidence tasks and adds a bounded evidence protocol. V1 and v2 scores are not directly interchangeable.

V2 requires the complete source text for both relevant log lines and all three cited artifact lines. The grader still uses exact `file_contains` criteria: surrounding prose is allowed, while a paraphrase, wrong retry, wrong line number, swapped citation, fabricated line, or missing output fails. This changes the future task contract and does not regrade historical v1 answers. Before collection, the v2 manifest SHA-256 is `8f71af26ecdb68aa2a88187342cdb1ef9177895b8668e44a178299c1810e1062`; the runner records the executed manifest, runner, adapter bundle, launcher, and native binary hashes in the new ledger before the first task starts.

The frozen live configuration is Codex CLI 0.159.2, `gpt-6.1-sol`, low reasoning effort, `workspace-write`, approval policy `never`, ephemeral sessions, isolated configuration, ignored repository rules, two concurrent independent pairs, and a five-minute wall timeout per run. The direct subscription client exposes no verified per-request output-token or provider-request cap, so neither is claimed or silently treated as enforced.

## Predeclared result

The primary metric is **verified completion rate**: successful completions divided by all scheduled runs. Report it per task and arm, then across the frozen suite. A failed run remains in the denominator.

The Sando arm fails the operational regression gate when either condition is true:

- it has at least two fewer successful completions than control on any one task; or
- it has more than one fewer successful completion than control across all 50 runs.

This is a release gate, not a statistical-equivalence test. Five repetitions per arm do not support an equivalence claim.

Economic results are secondary. Report both the cost of all attempts and the cost per successful completion. The latter is:

```text
cost of every run, including failed runs and retries / verified successful completions
```

Publish a cost comparison only if every scheduled run has complete monetary data and the regression gate passes. Token reduction alone does not establish savings when quality regresses.

## Authorization and freeze gate

Before a live run, obtain explicit authorization for the selected billing path. For this run the selected path is ChatGPT subscription authentication, not metered API usage. It has no API invoice or enforceable dollar meter. Then record these immutable inputs in the run directory:

- benchmark manifest bytes and SHA-256;
- repository commit and dirty-state status;
- Codex version, resolved binary path, and binary SHA-256;
- model identifier and exact snapshot when exposed;
- reasoning effort, instructions, permissions, OS, architecture, and Node version;
- the versioned pricing profile used after collection.

Do not change a task, fixture, success check, schedule, model, effort, or instruction between arms. A necessary change creates a new benchmark ID; it does not amend collected `sando-v1` results.

## Execution

Inspecting either manifest is read-only and derives separate ledger and evidence paths from its benchmark ID:

```sh
node scripts/run-sando-benchmark.mjs --manifest packages/sando/benchmarks/sando-v1.json
node scripts/run-sando-benchmark.mjs --manifest packages/sando/benchmarks/sando-v2.json
```

Historical v1 manifests, ledgers, summaries, source receipts, and archive directories cannot be targets of a new run. A v1 diagnostic therefore requires distinct explicit `--ledger` and `--evidence-dir` paths. V2 defaults to `sando-v2-events.jsonl` and `sando-v2-evidence`; the runner rejects unsafe benchmark/task IDs, overlapping ledger/evidence paths, and canonical, symlink, hard-link, ancestor, or descendant collisions with any historical v1 artifact. Outputs also cannot overlap the selected manifest, runner, subscription/loopback contracts, or Codex adapter bundle.

For a supervised v2 run expected to exceed the invoking terminal's capture lifetime, launch the runner outside `sando exec` as a detached local process with a private log and retain its PID:

```sh
umask 077
run_dir=$(mktemp -d /tmp/sando-v2.XXXXXX)
log_path="$run_dir/run.log"
pid_path="$run_dir/run.pid"
: > "$log_path"
chmod 0600 "$log_path"
nohup setsid node scripts/run-sando-benchmark.mjs \
  --manifest packages/sando/benchmarks/sando-v2.json \
  --run > "$log_path" 2>&1 < /dev/null &
printf '%s\n' "$!" > "$pid_path"
printf 'run_dir=%s pid=%s\n' "$run_dir" "$!"
```

Monitor the PID, private log, and versioned event ledger with short polling. Per-ledger and per-evidence-root lock directories use atomic owner tickets with PID/start metadata: concurrent live contenders fail safely, while verified dead or PID-reused tickets are removed. `SIGINT` and `SIGTERM` stop new scheduling, allow current attempts to finish within their existing five-minute bound, and leave every started run auditable. A timed-out attempt kills only its detached process group, including descendants, before workspace verification and cleanup. When the leader exits normally, the runner drains lingering descendants in that same owned process group with TERM followed by bounded KILL; a cleanup error prevents a passing outcome. On resume, a started run without a completion becomes one failed/unverified attempt and is never silently retried; its unavailable duration, tool-call, and artifact-retrieval metrics remain `null`. Malformed or truncated ledger lines stop resume with their line number. The runner removes only its own temporary workspaces and releases only its own tickets.

For each scheduled pair in manifest order:

1. Create two fresh workspaces from the same repository commit and materialize the task's `fixture.files` exactly.
2. Start each arm with a fresh client session and identical allowlisted environment. Set `SANDO_CLI_ROUTING=0` for `control` and `SANDO_CLI_ROUTING=1` for `apply`.
3. Run the exact task prompt. Follow the pair order stored for that repetition. Do not reuse a modified workspace or model conversation.
4. Measure wall-clock duration around the complete task. Count all agent retries, tool calls, and Sando artifact retrievals. Preserve observed cache-read and cache-write counters; use `unavailable` rather than zero when the provider did not report them.
5. Run every success criterion against the resulting workspace. `command` checks must exit zero; `file_contains` and `file_not_contains` operate on exact UTF-8 text. Record `passed` only when all checks pass. Record execution failures as `failed`; never discard or rerun them as if they did not occur.
6. Preserve the subscription usage counters reported by Codex. This run has no request-level API billing context, so API cost, supported subtotal, and cost per successful completion remain `null`/`indeterminate`; Codex subscription use is not an API invoice.

Each scheduled native execution produces one attempt record, including setup failures, timeouts, quota failures, and interrupted processes. A ledger entry left at `started` is converted to a failed, unverified attempt on resume and is not rerun. The paired order continues from the next scheduled arm. No failure is removed or replaced.

Before deleting each temporary workspace, v2 retains only regular, non-symlink final files named by `file_contains`/`file_not_contains` criteria, their verification record, and bounded redacted final-message/command fields. Protected fixtures and their hard links, arbitrary repository files, auth/config directories, environment variables, and raw Codex stdout/stderr/JSONL are excluded. The runner keeps exact initial subscription credential values only in memory, rereads the private auth copy after each child run to include rotations, and replaces those exact bytes in declared outputs and selected diagnostics before truncation or hashing. Synthetic fixture strings remain available as failure evidence; no original credential value or digest is retained. If private auth cannot be reread, the attempt fails, collection stops, and evidence remains unavailable without inspecting workspace outputs. Directories use mode `0700`; files use `0600`. Limits are 64 KiB per file, 256 KiB per attempt, and 32 MiB for the collection. File, message, command, command-count, and process-trace truncation are explicit; UTF-8 diagnostic limits never split a code point. Stored redacted bytes are hashed and reread for integrity, missing observed fields remain `null`, and an evidence-write failure is recorded on the attempt instead of being hidden. Evidence is retained through audit and deleted only after publication or cancellation is decided.

Per-attempt evidence provenance includes prompt and manifest hashes; executed runner, bundle, source, launcher, and native binary hashes; client version; authentication mode without credential values; requested model and effort; observed model when available; arm/order; timestamps; output hashes; and trace-truncation state. Collection-level ledger metadata additionally records both contract hashes and the full launcher-to-binary chain. The runner verifies that complete execution receipt before and after every child run. Metadata also freezes Git HEAD and source dirty state, Node/platform/architecture, sandbox, approval policy, rules/config isolation, model/effort, concurrency, and timeout; resume rejects material drift.

## Attempt records

Store one JSON object per completed run in JSON Lines format. The offline summarizer accepts only `sando.benchmark-attempt.v1` records. Example:

```json
{
  "schemaVersion": "sando.benchmark-attempt.v1",
  "benchmarkId": "sando-v1",
  "taskId": "locate-log-failure",
  "arm": "control",
  "repetition": 1,
  "orderPosition": 1,
  "outcome": "passed",
  "successVerified": true,
  "attempts": 1,
  "durationMs": 18342,
  "toolCalls": 3,
  "artifactRetrievals": 0,
  "cache": {
    "status": "observed",
    "readInputTokens": 1200,
    "writeInputTokens": 80
  },
  "cost": {
    "status": "complete",
    "estimatedApiCostUsd": 0.04321,
    "supportedSubtotalUsd": 0.04321
  }
}
```

`attempts` counts the initial task attempt plus agent-level retries. `toolCalls` counts all tool invocations across those attempts. `artifactRetrievals` counts explicit reads of Sando-preserved artifacts. `orderPosition` is 1 or 2 within the scheduled pair.

When no request can be priced, set `cost.status` to `incomplete`, `estimatedApiCostUsd` to `null`, and `supportedSubtotalUsd` to `null`. A numeric supported subtotal is allowed only when at least one request was priced. When cache counters are absent, set both cache counters to `null` and use `cache.status: "unavailable"`.

## Offline aggregation

`summarizeBenchmarkAttempts(records)` in `packages/sando/src/benchmark-accounting.mjs` validates records and groups results by benchmark, task, and arm. It does not contain tariffs and does not merge distinct tasks into one workload. A duplicate task/arm/repetition is rejected.

For each group it reports runs, verified successes and failures, internal attempt count, duration, tool calls, artifact retrievals, observed cache totals, unavailable-cache count, cost of all attempts, and cost per successful completion. If any run has incomplete monetary data, the total and cost per completion are `indeterminate`; the supported subtotal remains visible.

The suite-wide primary metric and regression gate should be calculated only after confirming that the records contain exactly the 100 combinations declared by the manifest. Missing runs remain a protocol violation and must never be interpreted as zero cost or a failed completion.

## Required publication fields

Publish the frozen-environment metadata, all per-task arm summaries, overall verified completion rates, the regression-gate result, infrastructure restarts, and every incomplete field. Keep provider-reported charges separate from list-price estimates and mechanical output reduction. Include failures, retries, and artifact retrievals in the released data.
