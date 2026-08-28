# Sando Plugin Adaptive Control Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the installable Sando plugin the complete, honest product surface with cache-aware measurement and adaptive backoff.

**Architecture:** Extend the canonical Node.js bundle with a pure adaptive controller and provider-relative cost accounting. Codex hooks label control/apply sessions, refresh the existing provider ledger, and fail open when paired evidence is insufficient or unfavorable. Ship the existing context-transform/proxy modules in the plugin bundle without pretending the plugin can reconfigure Codex's provider transport.

**Tech Stack:** Node.js 22 ESM, native test runner, JSON state files, existing Codex hooks/MCP/CLI, Python weekly report.

---

### Task 1: Add failing adaptive cost/controller tests

**Files:**
- Create: `packages/sando/tests/adaptive-control.test.mjs`
- Modify: `packages/sando/tests/provider-usage.test.mjs`

Write tests for cache-weighted cost, session aggregation, insufficient evidence, cost backoff, turn backoff, and optional arm metadata before implementation.

### Task 2: Implement the pure adaptive controller

**Files:**
- Create: `packages/sando/src/adaptive-control.mjs`
- Modify: `packages/sando/index.mjs`

Implement validated numeric cost units, session cohorts, and a conservative `decideAdaptiveRouting` function. No filesystem or provider calls belong in this module.

### Task 3: Label and refresh provider usage in the plugin lifecycle

**Files:**
- Modify: `packages/sando/src/provider-usage.mjs`
- Modify: `plugins/sando/hooks/provider-usage.mjs`
- Modify: `plugins/sando/hooks/pre-tool-use.mjs`
- Modify: `plugins/sando/lib/enforcement.mjs`
- Test: `plugins/sando/tests/provider-usage-hook.test.mjs`
- Test: `adapters/codex/sando/tests/enforcement.test.mjs`

Add optional arm/experiment/workload metadata, record final transcript usage at Stop, and bypass only when the adaptive controller has enough completed evidence that apply is worse or the evidence is unavailable. Keep all existing allowlists and fail-open host behavior.

### Task 4: Bundle the plugin runtime

**Files:**
- Modify: `scripts/sync-bundles.mjs`
- Modify: `packages/sando/tests/bundle-parity.test.mjs`
- Create: `plugins/sando/proxy.mjs`
- Create: `plugins/sando/bin/sando-proxy`

Ship adaptive, context-transform, history, proxy, and proxy-metrics modules in the plugin. Add a plugin-local proxy launcher requiring an explicit upstream URL.

### Task 5: Remove misleading RTK/token claims

**Files:**
- Modify: `scripts/weekly_report.py`
- Modify: `scripts/test_weekly_report.py`
- Modify: `packages/sando/src/metrics.mjs`
- Modify: `packages/sando/src/statusline.mjs`
- Modify: `packages/sando/tests/metrics.test.mjs`
- Modify: `packages/sando/tests/statusline.test.mjs`

Remove the RTK comparison and relabel mechanical reduction as diagnostic. Expose real provider usage/cost when available; never label estimated token reduction as provider savings.

### Task 6: Document plugin setup and evidence

**Files:**
- Modify: `README.md`
- Modify: `packages/sando/README.md`
- Modify: `plugins/sando/.codex-plugin/plugin.json`

Document the plugin-first install, control/apply arms, optional proxy configuration, adaptive behavior, and the distinction between provider usage and mechanical reduction.

### Task 7: Verify and review

Run focused red/green tests for every implementation task, then `npm test`, `npm run check`, Python weekly-report tests, `git diff --check`, package/bundle smoke checks, and a final code review of the diff. Do not publish, push, or deploy.
