## Goal

Complete the next Sando refinement against the external review: make every install path truthful, separate mechanical context trimming from provider billing, add a deterministic paired-control accounting primitive, measure extra turns/tool calls, keep MCP tradeoffs explicit, and harden `sando_exec`. Do the implementation and tests in the repository; do not stop at a plan.

## Constraints & Preferences

- The installable plugin is the product surface, but Claude marketplace, Codex marketplace, and npm `sandoichi` must be audited separately.
- Do not automatically move the proxy/request-transform stack into a marketplace plugin unless there is a clean, low-risk, actually wired integration path.
- Do not call mechanical reductions “tokens saved” or derive money saved from bytes/tokens. Provider cost must be provider-reported; mark estimates and counterfactual replays explicitly.
- Do not implement a production adaptive backoff controller in this tranche. Build only the deterministic measurement/analysis primitive that a future controller could consume.
- Prefer native hooks/transforms for eligible work; retain MCP only where it has a concrete benefit and document the possible extra-turn tradeoff.
- Preserve the cache guard: cache-control breakpoints, cache read/write accounting, rewrite payback threshold, idle-cache behavior, and host cache markers.
- Avoid secrets, network calls, publish, push, deploy, or destructive repository operations. Use `apply_patch` for edits.
- This workspace requires prefixing shell commands with `rtk`; use `rtk proxy <command>` for raw commands. Node target is `>=22.22.0 <23`.
- Do not weaken tests to make them pass. Keep the implementation small and evidence-driven.

## Progress

### Done

- Commit `9c4b34d Make Sando plugin adaptive and provider-aware` is the current clean baseline.
- Codex plugin bundle contains hooks, MCP server, CLI, provider ledger, and an explicit `bin/sando-proxy` launcher. See `plugins/sando/.codex-plugin/plugin.json`, `plugins/sando/.mcp.json`, `plugins/sando/hooks/hooks.json`, `plugins/sando/cli.mjs`, and `plugins/sando/README.md`.
- Canonical provider parser in `packages/sando/src/provider-usage.mjs` parses Claude/Codex input, cache-read, cache-write, output, reasoning, and total token counters; validates cache counters; derives fresh input; counts distinct turns; supports optional `apply/control`, experiment, and workload metadata.
- `packages/sando/src/statusline.mjs` no longer renders “token saved”. It renders provider tokens, turns, weighted cost units, and a real `$ / M` rate only when the host passes `totalCostUsd`. Claude's wrapper reads `status.cost.total_cost_usd`; Codex has no equivalent wrapper cost input.
- Mechanical reports were relabeled and the weekly report no longer compares against RTK or claims provider savings. Legacy schema/telemetry identifiers containing `SavingsTokens`/`inputTokensSaved` still exist for compatibility.
- PreToolUse classifies safe literal `cat`/fixed-string grep and rewrites eligible Codex shell calls to the bundled CLI. `sando_exec` remains sandboxed.
- MCP artifact persistence was restricted to `sando_exec`; read-only MCP calls no longer write `.sando` artifacts.
- `sando_exec`/CLI capture is incremental and bounded by `min(policy.maxArtifactBytes, 16 MiB)`; reaching the output cap no longer terminates the child, so side effects and exit status survive.
- Cache guard tests already cover breakpoints, host markers, payback, idle-cache behavior, cache read/write parsing, and preserved transformation behavior.
- Verification last passed: `npm test` (package: 266 subtests / 268 tests; benchmark: 142; bundle/plugin: 59), `npm run check`, `python3 -m unittest scripts/test_weekly_report.py`, and `git diff --check`.

### In Progress

- None in the worktree. This handoff starts the next implementation tranche from the clean commit above.

### Pending

- Add a short repository shipping matrix (there is no `docs/shipping-matrix.md` yet) and correct claims per install path.
- Reconcile the current docs with actual host wiring:
  - Claude manifest exposes hooks; it has copied context/history/proxy files and an MCP server file, but `adapters/claude/sando/.claude-plugin/plugin.json` does not declare MCP or a proxy/statusline integration.
  - Codex manifest declares `.mcp.json` and companion hooks; the plugin has no top-level statusline/metrics launcher even though internal statusline/metrics modules exist.
  - npm `sandoichi` is a library exporting APIs from `packages/sando/index.mjs`; it does not install hooks, an MCP server, or plugin launchers.
- Remove or demote the production adaptive controller. `packages/sando/src/adaptive-control.mjs` is exported and `plugins/sando/lib/enforcement.mjs` calls `decideAdaptiveRouting` during PreToolUse; this currently performs automatic apply/control backoff and violates the current requirement to postpone production adaptation. Preserve useful accounting logic only if it is converted into a measurement primitive.
- Build a separate accounting report/CLI, likely around `buildProviderUsageReport`, that exposes cache read/write, fresh input, output/reasoning, turns, provider-reported cost when present, and session blended effective rate. It must distinguish provider-reported data, weighted estimates, and unavailable data. The current report exposes weighted cost units but no `totalCostUsd` in the provider ledger and no separate accounting command.
- Extend paired analysis beyond `benchmarks/lib/metrics.mjs::pairDelta`, which currently compares mostly input-token estimates. The new deterministic result should include control/treatment, uncached input, cache reads/writes, output, reasoning, turns, tool-call counts, mechanical context trimmed, and real billed cost only when available. Replay/counterfactual fields must be explicit.
- Extend benchmark instrumentation. `benchmarks/live/codex-e2e-run.mjs`, `benchmarks/live/e2e-run.mjs`, and `benchmarks/live/proxy-e2e-run.mjs` currently return tool-path booleans and provider usage, not explicit model-turn, total-tool, Sando-MCP, or native-tool counts. Add deterministic fixtures and keep live runs optional/cost-gated.
- Audit/document MCP tradeoffs. `sando_read`, `sando_grep`, `prepare_tool_output`, and `sando_exec` are present in `plugins/sando/lib/mcp-tools.mjs`; native PreToolUse routing is preferred for literal shell reads/searches. Document when MCP adds a model turn and why `sando_exec` is concrete value; do not make a blanket MCP cost claim.
- Finish `sando_exec` hardening. `MAX_EXEC_CAPTURE_BYTES` remains 16 MiB; retention is incremental, but the cap decision and global stdout/stderr budget need review. Add tests for stderr under large stdout, timeout/termination, nonzero failures, pathological output, and multibyte UTF-8 boundary behavior. Current `textOrBinary` treats an incomplete UTF-8 sequence at the cap as binary/withheld.
- Add focused tests for shipping claims/matrix, accounting output, explicit counterfactual labeling, turn/tool counts, and UTF-8 boundaries. Keep existing cache-guard tests green.
- Update root/package/plugin documentation only after the matrix is factual; synchronize generated bundles with `npm run sync:bundles`.

## Key Decisions

- Keep the native Codex PreToolUse CLI route as the transparent path; Codex PostToolUse cannot replace output already delivered by a built-in tool.
- Keep provider proxy/context-history transformation opt-in and explicit. Do not imply that a plugin manifest automatically intercepts provider transport.
- Treat cache-aware weighted cost units as an estimate unless a provider/host supplies actual billing. Never convert them to dollars.
- A valid but insufficient ledger is not evidence of savings; it should report “insufficient evidence”. Invalid or unavailable data should fail conservatively.
- A future adaptive controller must wait for trustworthy paired evidence and quality/turn confounder handling; this tranche must not ship automatic backoff.

## Critical Context

- Repository: `/home/cristina/Projects/Sando`.
- Current branch: `main`; implementation baseline: `9c4b34d`; the handoff commits follow it; worktree is clean.
- Canonical sources are under `packages/sando/src`; generated standalone copies are under `plugins/sando/lib`, `adapters/codex/sando/lib`, and `adapters/claude/sando/lib`. Run `rtk proxy npm run sync:bundles` after canonical changes.
- Relevant existing entrypoints: `plugins/sando/bin/sando`, `plugins/sando/cli.mjs`, `plugins/sando/mcp/server.mjs`, `plugins/sando/proxy.mjs`, `adapters/claude/sando/statusline.mjs`, `adapters/codex/sando/statusline.mjs`, `packages/sando/src/metrics-cli.mjs`.
- Relevant existing tests: `packages/sando/tests/provider-usage.test.mjs`, `packages/sando/tests/statusline.test.mjs`, `packages/sando/tests/adaptive-control.test.mjs`, `packages/sando/tests/bundle-parity.test.mjs`, `packages/sando/tests/surfaces.test.mjs`, `benchmarks/tests/metrics.test.mjs`, `plugins/sando/tests/adaptive-routing.test.mjs`, `plugins/sando/tests/cli.test.mjs`, `plugins/sando/tests/exec.test.mjs`, and Codex exec/enforcement tests.
- Existing provider usage records are JSON state at `$XDG_STATE_HOME/sando/provider-usage.json` or `SANDO_PROVIDER_USAGE_PATH`; do not read real credentials or include environment secrets.
- Existing mechanical metrics deliberately retain compatibility fields such as `estimatedTransformSavingsTokens`; if renaming them, use a migration/compatibility strategy and ensure all public text says “mechanical reduction” or “context trimmed”, never billed savings.
- The previous external review was right that extra turns and cache behavior can erase apparent reductions, but a blanket claim that MCP is always more expensive is not a Sando-specific causal result. Measure it per host/model/workload.

## Next Steps

1. Re-read the current manifests and public docs, then write `docs/shipping-matrix.md` with a before/after factual table for Claude marketplace, Codex marketplace, and npm `sandoichi`.
2. Add failing tests for the accounting report, provider-reported cost/unavailable states, counterfactual paired output, explicit turn/tool counters, and truthful install-path documentation.
3. Remove production use of `decideAdaptiveRouting`; retain only the smallest pure analysis API needed for paired evidence, and update the plugin CLI/docs accordingly.
4. Implement the accounting and paired-analysis primitives, then extend deterministic/live benchmark instrumentation without introducing automatic adaptation.
5. Harden `sando_exec` UTF-8/stdout/stderr behavior and add the missing regression tests.
6. Synchronize bundles, run focused tests, then run:
   - `rtk proxy npm test`
   - `rtk proxy npm run check`
   - `rtk proxy python3 -m unittest scripts/test_weekly_report.py`
   - `rtk proxy git diff --check`
7. Review the final diff for claims/scope, leave automatic adaptive backoff as explicit future work, and commit locally only. Do not push, publish, or deploy.
