# Codex compatibility evidence

Sando keeps offline contract checks separate from live Codex compatibility. Run the deterministic checks with:

```sh
npm run verify:codex-compat
```

Exercise the installed Codex client against the synthetic loopback Responses provider with:

```sh
npm run verify:codex-compat:loopback
```

Pass `-- --keep` only for harness debugging. It preserves the temporary root path after cleanup; the retained directory is empty and contains no prompt, hook, provider, output, or error payload.

The separate subscription probe below is an authenticated call that can consume ChatGPT subscription quota. It is not part of the loopback check and must be run only when that authenticated call is intended:

```sh
npm run verify:codex-compat:subscription
```

The loopback command exits successfully only when both the lifecycle/rewrite checks and the app-server approval-denial gate pass.

The runner uses synthetic fixtures, creates private temporary HOME, CODEX_HOME and XDG directories, and builds the child environment from an allowlist. It does not inherit API keys or existing Codex configuration. The check does generate synthetic HTTP/SSE traffic on `127.0.0.1` between the client and the local fixture provider. It makes no external network call and no authenticated model-provider call, and does not change global configuration.

## Candidate matrix

| Codex version | Offline local contract | Synthetic loopback client | Authenticated provider | Claim |
|---|---|---|---|---|
| 0.160.0 | Version-independent local suite passed | `passed`: nine fully gated direct MCP and Code Mode cases | `not-run` | Local stock-client behavior only |
| 0.159.2 | Version-independent local suite passed | `passed`: lifecycle, rewrite, denial and sandbox checks | `passed`: ChatGPT subscription | API billing remains unverified |
| 0.153.4 | Version-independent local suite passed | `not-run`: binary absent | `not-run` | Historical comparison candidate only |

The offline column reports the same local Sando contract suite for both rows; it does not execute either Codex version. Finding a binary and printing its version is recorded as environment metadata. It never changes `not-run` to `passed`. A live receipt must show that the client invoked the installed hooks and consumed the returned `updatedInput`; process startup alone is insufficient.

The Luna subscription pilot below uses the isolated local prototype, not stock Codex. The 0.160.0 stock-client `Authenticated provider` entry therefore remains `not-run`.

The final offline snapshot on 2026-10-02 passed 11/11 checks with no provider call. Its private receipt records the dirty-worktree HEAD, status/diff digest and the 68-file Codex bundle SHA-256 `699709bbb8c301c7bc5120a877b498785daa4551d99c08d773d73edabf69e5a0` in `.internal/openai-contract/a0-final-2026-10-02.json` (mode 0600). The synthetic compatibility receipt below also stores one `worktreeManifestHash` digest of the status and binary diff; neither receipt contains a per-file inventory.

## Codex 0.159.2 loopback receipt

This historical receipt remains a separate 0.159.2 lifecycle/rewrite/denial receipt. It is not replaced or upgraded by the 0.160.0 MCP output evidence below.

The real 0.159.2 client ran with a private temporary CODEX_HOME, HOME and XDG tree, `workspace-write` sandbox, an allowlisted environment, blocked external proxies, and a Responses SSE server bound to `127.0.0.1`. `requires_openai_auth` was false. No provider credential, user configuration, external model, or paid endpoint was used.

Observed through the client:

- `SessionStart` delivered `source: startup`, then `source: resume` on `codex exec resume --last`.
- A real `PreToolUse` payload named the shell surface `Bash`. The captured, sanitized payload is `packages/sando/tests/codex-compat/pre-tool-use.codex-0.159.2.loopback-capture.json`.
- Sando returned `updatedInput`; `PostToolUse` contained the rewritten Sando command and its `[sando exec ...]` output, and the next loopback provider request contained that bounded output.
- The provider streamed multiple SSE events with short delays. The command appended exactly one marker, so streaming and the second model turn did not cause a second execution. This shell surface completed synchronously; a distinct tool-poll operation was not exposed and remains `not-run`.
- Resume completed in the same isolated thread. The synthetic provider received five local requests across the run, resume, and denial probe.

Hook trust was bypassed only for the lifecycle/rewrite probe because a new isolated CODEX_HOME has no persisted trust decision. Codex reports `permission_mode: bypassPermissions` in that mode, so that part of the receipt does not support an approval claim. The approval probe uses app-server separately: it reads each hook's `currentHash` through `hooks/list`, writes those exact hashes only to the temporary config, restarts app-server without a trust bypass, and starts a thread with `approvalPolicy: on-request`, reviewer `user`, and sandbox `workspace-write`.

## Codex 0.160.0 MCP and Code Mode receipt

App-server notification retention is capped by aggregate entry and byte limits. The harness retains only the notification method and required turn id, handles server requests without queueing their parsed payloads, and closes the app-server fail closed when either limit is exceeded.

Client identity hashes distinguish the invoked wrapper, the safely resolved JavaScript launcher, and the native binary for the current platform. Any identity that cannot be resolved from an absolute file path remains `null`.

The installed stock client was exercised with a synthetic stdio MCP server and the same local Responses provider. The harness used disposable HOME, CODEX_HOME and XDG directories and did not copy authentication. It captures the actual HTTP request `Buffer` before JSON parsing, then retains only its byte count and SHA-256, the exact byte offsets/length/hash of the marker-containing serialized JSON string, its byte delta from the matching no-hook control, marker booleans, execution counts and structural classifications. Process output, app-server protocol lines/stderr, and provider request bodies have fixed memory caps; overflow closes the affected process or request and produces a bounded `failed` reason. It stores or prints no raw provider request, hook payload, prompt, tool/model output, stderr or error text. `--keep` deletes all transient contents and retains only an empty private temporary root whose path is returned in the report.

Every scenario is a `sando-openai-output-contract/v1` receipt. Its deterministic core contains structured provenance; wrapper, launcher and native-binary SHA identities (nullable when unknown); Sando HEAD, worktree manifest and bundle hashes; the pinned tag/commit with commit match explicitly `unknown`; scenario id/surface/stage/hook/result type; sanitized process, promise, typed-value, execution, approval and cancellation observations; original result UTF-8 bytes separately from exact HTTP body bytes/hash; provider usage `null`; local request estimates; detailed recovery fields; and verifier version. Recovery is `not-needed` with null detail fields for these A1 fixtures. `generatedAt` exists only on the aggregate report and can be supplied by an injected clock. Each receipt has a SHA-256 digest over that deterministic core. A passing scenario requires Codex to exit zero without a signal or timeout. The aggregate declares `profile: full-a1` and requires all nine named cases; the offline-only runner uses the explicit `not-requested` profile with no target receipts.

- Direct MCP without a hook executed once. The next provider request contained both the raw marker and typed `structuredContent.count = 3`; this control proves that the surface exposed the raw fixture before replacement was tested.
- The exact current fallback from `buildCodexFallback()` executed once. Its fixed fallback marker reached the next provider request while the raw and replacement markers and typed value did not. This proves the fallback's stop-message behavior; it does not prove transparent output rewriting.
- Direct MCP with a successful `PostToolUse` response containing `continue: false` executed once. The next provider request contained the replacement marker and omitted the raw marker.
- Direct MCP with a blocking `PostToolUse` exit executed once. The next provider request contained the bounded replacement marker, omitted the raw and typed result, and the receipt classifies the observed hook effect as blocked.
- Code Mode without a hook executed once and exposed the raw marker and typed value, establishing its independent control. Code Mode uses the pinned stock binding `tools.mcp__fixture__fixture_report(...)`, derived from the client-generated MCP namespace. With the same `continue: false` hook, JavaScript received the original typed result: the next provider request contained the raw marker and `count = 3`, and omitted the replacement marker.
- A yielded Code Mode cell was first run without a hook, then separately with `continue: false`. Both paths resumed through `wait`, emitted the resolved promise sentinel and exposed the original typed result. The wait comparison uses the no-hook wait span as its baseline, rather than the execute-only control.
- Code Mode constructs resolved, rejected and withheld sentinel strings only at runtime. The report classifies the exact sentinel separately from raw/replacement visibility. With a blocking `PostToolUse` outcome (exit 2), the MCP operation executed once and emitted the rejected sentinel. The next provider request omitted raw, replacement and fallback markers; no ambiguous rejection is inferred from their absence.
- The top-level MCP `_meta` marker was absent from Code Mode output while `content`, `structuredContent` and `isError` remained available. This matches the pinned serialization path.

| A1 output case | Status |
|---|---|
| Direct: no hook | `passed` |
| Direct: current `buildCodexFallback()` | `passed` |
| Direct: `continue:false` replacement | `passed` |
| Direct: blocking hook | `passed` |
| Code Mode execute: no hook | `passed` |
| Code Mode execute: `continue:false` | `passed` |
| Code Mode wait: no hook | `passed` |
| Code Mode wait: `continue:false` | `passed` |
| Code Mode execute: blocking hook | `passed` |
| MCP `isError:true` result behavior | `not-run` |
| Raw app-server RPC error containment | `passed` (bounded classification only) |

These are observations of Codex 0.160.0 stock behavior. They do not claim transparent Code Mode replacement support. Per-scenario, surface and aggregate status is limited to `passed`, `failed` or `not-run`. A completed scenario with any wrong observation is `failed`; only an unavailable binary or surface is `not-run`. The implementation is based on the pinned Codex source commit `a956835d020762cb2b570053af06f643a11c0ecc`; the local binary identity is versioned as 0.160.0 but is not proven byte-for-byte identical to that source commit.

## Codex 0.160.0 synthetic artifact-recovery receipt

The isolated installed client ran Code Mode against the local Responses loopback provider and the real Sando output-transform helper and stdio MCP server. The helper created a redacted 19,512-byte artifact in the temporary workspace. One `sando_artifact_get` execution returned exactly lines 319–321: 99 bytes with the matching SHA-256; the synthetic marker outside the requested range was absent. The captured provider request was 63,246 bytes. The wrapper, launcher, native binary, helper, MCP server, recovered artifact and captured request are identified by SHA-256 in `.internal/openai-contract/d-recovery-2026-10-02.json` (mode 0600).

This proves the stock client's Code Mode can recover an exact bounded range through Sando's real helper and server under a synthetic provider. It does not exercise the proposed Codex `ModelOutputTransform` hook, which stock 0.160.0 does not implement. No authenticated provider call was made; request bytes do not establish token usage, savings, latency or answer quality.

## MCP aggregate envelope budget

Sando tools that already expose a `policy` object accept `policy.maxEnvelopeBytes`. This is a transport limit distinct from `maxInlineBytes`: `maxInlineBytes` still controls the preview produced by the output policy, while `maxEnvelopeBytes` limits the UTF-8 bytes of the complete JSON-RPC response written to stdout, including its trailing newline. The default on every Sando MCP tool response is 16,384 bytes; accepted explicit values are 512 through 1,048,576 bytes. Tools without a policy input, including artifact recovery and Slice, use the default so their catalog definitions stay bounded.

When an artifact-backed result would exceed the aggregate limit, Sando reduces only the preview and recomputes its disclosure metadata. It retains `content`, `structuredContent`, `source`, `route`, artifact handle, disclosure and recovery instructions. The serialized JSON is always emitted whole. If the required success envelope cannot fit, Sando returns `isError: true` with schema `sando-mcp-envelope-error/v1`, the applied byte limit and an explicit recovery availability field. Oversized passthrough results, including Slice results without a Sando artifact, use the same bounded error with recovery marked unavailable.

This limit covers responses produced by the Sando Codex adapter and plugin MCP stdio entrypoints. Claude’s separate MCP entrypoint and other MCP servers are outside this change. It does not establish a provider request limit or transform results emitted by other MCP servers.

Protocol and control-plane responses use a separate fixed 1,048,576-byte cap. This includes initialize, ping, tool discovery, protocol errors, parse errors and internal errors; `maxEnvelopeBytes` does not reduce that control-plane allowance. Every response still passes through the bounded writer. If an echoed request ID alone prevents a complete error envelope from fitting, Sando emits the complete minimal error with `id: null` rather than slicing JSON.

## What the offline check proves

The hook fixtures are labeled `synthetic`. They verify the local `PreToolUse` JSON contract for `Bash` and `exec_command`, stable bypass of an unknown tool, and the actual Codex enforcement source at `adapters/codex/sando/lib/enforcement.mjs`.

The shell fixtures execute the same synthetic command natively and through the returned Sando rewrite in separate workspaces. They compare normalized exit status, stdout, stderr, stdin handling, working directory, and file hashes. Cases cover quoting and Unicode, a pipe, a redirect, nonzero exit, signal termination, binary output, and file effects. Binary bytes are deliberately withheld from model-visible output; the check verifies that disclosure rather than byte equality.

## Open client-boundary evidence

The app-server approval probe produced a real `PermissionRequest` with `permission_mode: default`. The hook returned `behavior: deny`; app-server emitted no fallback approval request and the outside-workspace marker was absent. A second non-escalated outside-workspace write also left no marker, confirming the `workspace-write` boundary remained active. The probe did not auto-approve or disable the sandbox.

## Authenticated subscription receipt

The native 0.159.2 client completed one authenticated `gpt-6.1-sol` probe with low reasoning effort. The probe copied only `auth.json` into a disposable CODEX_HOME, trusted the repository's Sando hooks by their exact `hooks/list` hashes, used `workspace-write` with approval policy `never`, and removed the temporary auth copy afterward. The model executed one synthetic command once, Sando's rewritten command reached `PostToolUse`, and the marker was written once.

This authenticated receipt covers model availability, session startup, one shell rewrite, consumption of the rewritten command, and sanitized usage reporting. It does not extend the loopback-only approval result to the subscription service. The harness does not inherit `OPENAI_API_KEY`, rejects non-ChatGPT auth and near-expiry access tokens, and removes auth-bearing temporary state on success and failure. It stores neither credentials, prompts, model output, nor raw provider payloads in this document.

Sanitized usage reported by Codex was 28,994 input tokens, including 24,576 cached tokens, 0 cache-write tokens, 55 output tokens, and 0 reasoning tokens. Duration was 9.226 seconds. This is ChatGPT subscription usage: API cost is unavailable and must remain `null`/`unpriced`.

The local profile contains no API key, so the official `responses/input_tokens` API preflight could not be sent. API billing remains unverified and any API-priced workflow must stay fail-closed until a key passes that preflight. Codex 0.153.4 remains absent and `not-run`.

Unknown future hook events remain `not-run` until a versioned client contract exists. The synthetic unknown-tool fixture proves only the current local fallback. Direct MCP replacement and Code Mode value preservation are separate stock-client surfaces. These limits are emitted in the runner report so an offline pass cannot be read as live compatibility.

## Local model-output transform prototype

The local Codex prototype is based on release commit `a956835d020762cb2b570053af06f643a11c0ecc` (`rust-v0.160.0`) in `/home/gumi/Documenti/Sando/.internal/openai-contract/codex-prototype/codex-rs`, branch `work/sando-model-output-transform-v0.160.0`. It is an isolated research worktree. The installed Codex 0.160.0 client, its wrapper, and the control checkout were not modified. Stock Codex has no `ModelOutputTransform` capability; Sando does not enable the experimental hook automatically.

The prototype adds an opt-in, trusted, synchronous hook at the model-visible output boundary. It transforms text segments while preserving media, call status, opaque fields, MCP results consumed by Code Mode JavaScript, and the original typed JavaScript value. Direct MCP and Code Mode execute, wait, and notify have explicit integration paths. Request, stdout and stderr are each bounded to 1 MiB; execution has a timeout and cancellation terminates the helper. The C2 Sando helper validates the versioned contract and stores the redacted artifact before returning its bounded preview. Only exact successful Sando recovery views are exempted; unrelated text in the same Code Mode cell is still transformed. The helper is not activated against stock Codex.

The source worktree is separately identified by `.internal/openai-contract/codex-prototype-manifest-2026-10-02.json` (0600): 50 changed files in the `codex-rs` subtree are recorded by per-file SHA-256 with aggregate SHA-256 `76ffac23a9931237153658993c0afbf7ff96e8933ffd08529ebcf4b953eedf88`. This refreshed manifest includes the app-server managed-hook mapping and TUI hook-label compile fixes used by the built pilot binary. Generated `.sando` wrapper artifacts and the outer build inventory are excluded.

### Live A/B pilot — Luna high subscription (2026-10-02)

12 sequential authenticated sessions used `gpt-6-luna` with `high` reasoning through the ChatGPT subscription. Three synthetic MCP reports were run twice each. Control and treatment used the same local Codex 0.160.0 prototype binary and isolated environments; treatment enabled only the trusted Sando `ModelOutputTransform` hook. Luna ran through Code Mode, and all treatment hook events were `code-mode-execute`. No API key, web search, shell tool, user data, or external fixture was used.

| Measure | Control | Sando treatment |
|---|---:|---:|
| Attempts / fully gated runs | 6 / 5 | 6 / 6 |
| Observed exact answers | 6 / 6 | 6 / 6 |
| Mean input tokens in the five complete pairs | 26,210.2 | 22,580.4 |
| Mean fixture / transform bytes | 16,080.6 fixture bytes in verified controls | 16,093.7 hook input → 4,128 delivered |
| Mean end-to-end runner duration for fully gated runs | 9.75 s | 10.55 s |

All 12 observed final answers were exact; 11/12 runs passed every persisted gate. The first control answer is correct, but its CLI exit status, timeout/overflow state and hook-gate value were not persisted, so that run is marked `incomplete` and excluded from paired comparisons. The five complete paired input-token savings were 3,749, 3,624, 3,505, 3,640 and 3,631, averaging 3,629.8 (13.85% of paired control input). Across all six treatment runs, Sando reduced model-visible text by 11,966 bytes/run on average (74.35%). All six synthetic redaction sentinels were absent from transformed output, and each requested decision marker remained available. Across all 12 attempts, Codex reported 292,677 input tokens (175,872 cached), 2,567 output tokens and 1,568 reasoning output tokens. Runner durations include local setup, temporary auth copying, hook trust and Codex execution; they are not provider-only latency. This descriptive pilot is too small to establish general quality or savings.

The original harness incorrectly promoted that control run based on the `mcp_tool_call` event name without retaining all other gates. The review correction restored it to `incomplete`; the append-only audit records both transitions. No run was retried. Private mode-0600 receipts are `.internal/openai-contract/luna-high-subscription-pilot-20261002.jsonl`, `.internal/openai-contract/luna-high-subscription-pilot-20261002-summary.json` and `.internal/openai-contract/luna-high-subscription-pilot-20261002-audit.jsonl`. Subscription quota was consumed; API billing is `null` and no API-billed request was made.

### Verification status

| Surface | Status | Evidence / limit |
|---|---|---|
| Sando static checks | `passed` | `npm run check` |
| Sando package tests | `passed` | Full `npm test`: 726 passed, 10 skipped, 0 failed; private output at `.internal/openai-contract/final-npm-test-2026-10-02.log` (0600). `npm run check` passed. |
| Sando bundle tests | `passed` | Full `npm test`: 146 passed, 0 failed. The test-only PATH in `.internal/openai-contract/codex-test-path/bin` links the configured wrapper and its original NPM launcher so sandbox fixtures resolve the installed native binary; no global install or configuration change. |
| Codex hook/config/protocol/app-server crates | `passed` | 191/191 hooks, 345/345 config, 366/366 protocol, 313 app-server protocol tests; one generator test ignored |
| Codex core compile | `passed` | `cargo check -p codex-core` |
| Direct MCP output transform | `passed` | Integration test observed transformed text in the next model request, absence of the raw marker, canonical provider-visible tool identity, call ID, and `recoveryDelivery=false` |
| Codex Code Mode host build | `passed` | Locally built `codex-code-mode-host` from the pinned Codex source using the official V8 source release in the isolated toolchain cache. |
| Direct MCP and Code Mode execute/wait/notify | `passed` | `just test -p codex-core model_output_transform`: 16 passed, 0 failed, 4,858 filtered; covers typed values, structured content, media, MCP `isError` and RPC errors, denied approval, single side effect, multiple notify/execute segments, wait/yield and interrupt without orphan delivery. |
| Trusted transform-hook IPC, timeout and cancellation | `passed` | `just test -p codex-hooks model_output_transform`: 10 passed, 0 failed, 182 filtered; covers trusted registration, one synchronous handler, malformed replies, invalid UTF-8 rejection, size cap, timeout and helper termination. |
| Code Mode recovery-view preservation | `passed` | Integration coverage uses provider-visible `mcp__sando__sando_artifact_get`; successful Sando recovery output is retained while ordinary execute/notify text is transformed. |
| Installed stock Code Mode: helper-created artifact to exact-range MCP recovery | `passed` | Synthetic receipt above: real Sando helper and server; one call; exact redacted text, digest, range and byte count; no out-of-range marker. This does not test the new host hook. |
| Prototype host recovery from a Sando-created artifact through Code Mode | `passed` | `SANDO_REPO_ROOT=/home/gumi/Documenti/Sando just test -p codex-core sando_real_code_mode_artifact_recovery_end_to_end -- --ignored`: 1 passed, 4,873 filtered. Receipt: `.internal/openai-contract/candidate-host-recovery-2026-10-02.json` (0600). The helper creates the artifact, MCP returns exact redacted lines 63–65 and matching SHA-256, and the hook transforms ordinary text while excluding the recovery view. Uses local mock Responses; no provider/API call. |
| Small-output no-op and multi-text indexed edits | `passed` | `node --test packages/sando/tests/output-transform-cli.test.mjs`: 8/8 passed; no edits or artifact for small output and only the oversized indexed segment is changed. |
| `isError:true` and structured-content preservation | `passed` | Prototype tests preserve MCP error status and typed Code Mode values while replacing only model-visible text. Stock A1 `isError:true` observation remains `not-run`. |
| Provider usage, token savings, accuracy | `partial` | Luna high subscription pilot above on the local prototype: five fully gated pairs, 11/12 fully verified runs, all 12 observed answers correct, 13.85% paired input-token reduction and 74.35% treatment text-byte reduction. Provider-only latency was not isolated; stock Codex remains `not-run`. |

The deterministic prototype suite covers direct MCP and Code Mode delivery paths against the locally built host. The stock-client receipts separately prove current 0.160.0 MCP/Code Mode and exact artifact recovery behavior. They do not make the prototype capability available in stock Codex. The Luna figures are a small synthetic pilot on the local prototype, not a released Codex capability or a general performance claim. No new measurement is added to `docs/measurements.md`.
