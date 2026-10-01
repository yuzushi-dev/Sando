# Codex compatibility evidence

Sando keeps offline contract checks separate from live Codex compatibility. Run the deterministic checks with:

```sh
npm run verify:codex-compat
```

Exercise the installed Codex client against the synthetic loopback Responses provider with:

```sh
npm run verify:codex-compat:loopback
```

Run the minimal authenticated ChatGPT subscription probe with:

```sh
npm run verify:codex-compat:subscription
```

The loopback command exits successfully only when both the lifecycle/rewrite checks and the app-server approval-denial gate pass.

The runner uses synthetic fixtures, creates private temporary HOME, CODEX_HOME and XDG directories, and builds the child environment from an allowlist. It does not inherit API keys or existing Codex configuration. It makes no model or network call and does not change global configuration.

## Candidate matrix

| Codex version | Offline local contract | Synthetic loopback client | Authenticated provider | Claim |
|---|---|---|---|---|
| 0.159.2 | Version-independent local suite passed | `passed`: lifecycle, rewrite, denial and sandbox checks | `passed`: ChatGPT subscription | API billing remains unverified |
| 0.153.4 | Version-independent local suite passed | `not-run`: binary absent | `not-run` | Historical comparison candidate only |

The offline column reports the same local Sando contract suite for both rows; it does not execute either Codex version. Finding a binary and printing its version is recorded as environment metadata. It never changes `not-run` to `passed`. A live receipt must show that the client invoked the installed hooks and consumed the returned `updatedInput`; process startup alone is insufficient.

## Codex 0.159.2 loopback receipt

The real 0.159.2 client ran with a private temporary CODEX_HOME, HOME and XDG tree, `workspace-write` sandbox, an allowlisted environment, blocked external proxies, and a Responses SSE server bound to `127.0.0.1`. `requires_openai_auth` was false. No provider credential, user configuration, external model, or paid endpoint was used.

Observed through the client:

- `SessionStart` delivered `source: startup`, then `source: resume` on `codex exec resume --last`.
- A real `PreToolUse` payload named the shell surface `Bash`. The captured, sanitized payload is `packages/sando/tests/codex-compat/pre-tool-use.codex-0.159.2.loopback-capture.json`.
- Sando returned `updatedInput`; `PostToolUse` contained the rewritten Sando command and its `[sando exec ...]` output, and the next loopback provider request contained that bounded output.
- The provider streamed multiple SSE events with short delays. The command appended exactly one marker, so streaming and the second model turn did not cause a second execution. This shell surface completed synchronously; a distinct tool-poll operation was not exposed and remains `not-run`.
- Resume completed in the same isolated thread. The synthetic provider received five local requests across the run, resume, and denial probe.

Hook trust was bypassed only for the lifecycle/rewrite probe because a new isolated CODEX_HOME has no persisted trust decision. Codex reports `permission_mode: bypassPermissions` in that mode, so that part of the receipt does not support an approval claim. The approval probe uses app-server separately: it reads each hook's `currentHash` through `hooks/list`, writes those exact hashes only to the temporary config, restarts app-server without a trust bypass, and starts a thread with `approvalPolicy: on-request`, reviewer `user`, and sandbox `workspace-write`.

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

Unknown future hook events are `unsupported` until an observed, versioned client contract exists. The synthetic unknown-tool fixture proves only the current local fallback. External MCP output is outside the shell hook surface. These limits are emitted in the runner report so an offline pass cannot be read as live compatibility.
