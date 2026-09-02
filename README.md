<p align="center">
  <img src="assets/sando-mark.png" alt="Sando logo" width="96">
</p>

# Sando

Sando is a local plugin for Claude Code and Codex. It keeps repeated and oversized tool output under control, preserves complete redacted artifacts when they fit the admission limit, and provides bounded local tool surfaces. It runs locally and makes no LLM calls.

## Install the plugin

Install Sando from the host marketplace. Each marketplace source includes its hooks and bundles, so installation needs no build step.

### Requirements

- Claude Code or Codex
- Node.js `>=22.22.0 <23`, with `node` available in `PATH`

Check the Node version with:

```bash
node --version
```

### Claude Code

Run these commands in Claude Code:

```text
/plugin marketplace add yuzushi-dev/yuzushi-plugins
/plugin install sando@yuzushi
```

### Codex

Add the marketplace:

```bash
codex plugin marketplace add yuzushi-dev/yuzushi-plugins
```

Then open `/plugins`, select `sando`, and install/enable it. Start a new session if Codex was already open.

Each host wires only the hooks and MCP surfaces declared by its manifest. The remaining bundled CLI, audit/planner/artifact recovery, proxy, statusline, metrics, and accounting launchers are manual entrypoints; see the [shipping matrix](docs/shipping-matrix.md). The bundle is self-contained; the optional npm package is not required.

## Provider accounting and paired controls

Sando records provider-reported input, cache-read, cache-write, output, reasoning, and turn counts at session stop. It also records mechanical context trimming separately. A weighted token estimate is diagnostic; provider cost and blended rates are shown only when the provider or host reports them.

Run an explicit control session with the plugin still installed:

```bash
SANDO_EXPERIMENT=read-heavy \
SANDO_EXPERIMENT_ARM=control \
codex
```

Treatment sessions use `SANDO_EXPERIMENT_ARM=apply` (the default). Use the same experiment and optional `SANDO_EXPERIMENT_WORKLOAD` for both arms. Generate the accounting report from the installed Codex plugin:

```bash
/path/to/installed/sando/bin/sando accounting --json
```

The paired report exposes control/treatment cache classes, output and reasoning tokens, model turns, native/Sando tool calls, mechanical bytes, and billed cost when available. It marks replay results as counterfactual and never turns mechanical reduction into a provider-billing claim.

The statusline shows Sando's context tokens saved and the reduction percentage. A leading `~` marks an estimate; provider-reported savings omit it. Provider token accounting remains available through the accounting report.

## Context footprint audit

The read-only audit measures an explicitly captured initial-context body for Claude Code or Codex. It attributes observable bytes to host/project instructions, skills, built-in tools, direct/deferred MCP, Sando, history, prompt, provider overhead, and `unknown`. It never uses provider totals to invent a category breakdown. If the host body is not exposed, the result is `unavailable`.

Run it from an installed Codex bundle:

```bash
/path/to/installed/sando/bin/sando context audit --host codex --input capture.json --json
```

The Claude bundle exposes the same command through `node context-audit.mjs`:

```bash
node /path/to/installed/sando/context-audit.mjs context audit --host claude --input capture.json --json
```

Without a capture it reports the honest boundary:

```bash
/path/to/installed/sando/bin/sando context audit --host claude
```

Capture files use `sando-context-capture/v1`. They contain byte counts or ephemeral content for classified segments; reports retain only numeric totals and provenance digests, never paths, prompts, or secrets. Mechanical token estimates (`ceil(UTF-8 bytes / 4)`) and provider-reported usage are separate evidence classes.

## Instruction progressive disclosure

### F2 daily review

F2 provides an optional daily, preview-only instruction-planning workflow when
its runner and self-hosted telemetry collector are configured. Review aggregate
trends and labels in Grafana, outside this repository. Sando does not apply a
plan automatically. The runner remains usable with telemetry disabled; snapshot
and review uploads require explicit telemetry consent and still honor
`DO_NOT_TRACK`, including for a loopback collector.

Preview procedure-like moves from `AGENTS.md`/`CLAUDE.md` into portable Claude/Codex skills:

```bash
/path/to/installed/sando/bin/sando context plan-instructions --root . --host both --json
```

The planner is deterministic and emits content-free structured move previews with byte counts and redacted-content digests. It keeps safety and ambiguous blocks always-on, rejects `--apply`, and never edits project instructions or skills.

Evaluate the explicit Lazy MCP Gateway gate from a redacted, numeric evidence file:

```bash
/path/to/installed/sando/bin/sando context gateway-gate --input gateway-evidence.json --json
# Claude bundle: node /path/to/installed/sando/gateway-gate.mjs context gateway-gate --input gateway-evidence.json --json
```

The evidence schema is `sando-progressive-gateway-evidence/v1`. The evaluator
requires native Tool Search control data, both hosts, ten paired samples and 50
discovery intents per host, isolated original MCPs, unchanged digests,
provider-reported metrics, a read-only allowlisted catalog, tested rollback, and
the explicit safety/quality thresholds. Missing evidence stays
`insufficient-evidence`; no gateway is enabled by this command.

The evaluator validates the supplied redacted summary structurally; its digest is
an integrity checksum, not authentication of provider provenance. A `go` result is
not authorization to build or enable the gateway unless the summary is traced back
to the authorized paired runner outputs. Live scenario evidence exists, but the
spike is implemented locally and remains disabled; the production gate remains
`insufficient-evidence` because the native Tool Search control arm and a
complete paired matrix are still missing.

## Result progressive disclosure

Large Read, Grep, Bash/log, and MCP results expose a bounded preview plus a `sando-result-disclosure/v1` record. The record contains redacted byte counts, provenance, elision markers, and a digest handle; it never contains the full payload. Recover a bounded byte or line range from an installed workspace artifact with:

```bash
/path/to/installed/sando/bin/sando artifact get --root . --ref sando:sha256:... --start-line 1 --end-line 40 --json
# Claude bundle: node /path/to/installed/sando/artifact.mjs artifact get --root . --ref sando:sha256:... --json
```

`maxArtifactBytes` is an admission limit, not a truncation target. If the complete
redacted result exceeds it, Sando keeps only a bounded preview, does not issue an
artifact handle, and marks recovery unavailable instead of pretending a partial
artifact is complete.

MCP results expose the read-only `sando_artifact_get` tool for artifacts kept in that MCP process. Claude PostToolUse and Codex artifact paths preserve their existing host boundaries; errors, current results, IDs, order, batches, and binary status remain untouched.

The opt-in provider proxy also emits `sando-history-disclosure/v1` metadata for history elisions: each change has digest/byte accounting and explicitly says whether to rerun the tool or use the newer result. Proxy history is not falsely advertised as an MCP artifact.

The Lazy MCP Gateway spike is implemented but disabled by default. It is a replacement
surface for explicitly allowlisted external MCP servers, not a wrapper around host
built-ins. Configure `SANDO_MCP_GATEWAY_CONFIG` with JSON (or an explicit JSON file
path) containing `enabled`, `allowlist`, and `servers` entries with `command`/`args`,
then run `node packages/sando/gateway.mjs`. Do not expose the same MCPs through the
host at the same time. Roll back by stopping this process and removing the gateway
MCP entry; setting `enabled: false` is the safe kill switch. No Claude/Codex global
configuration is changed by Sando. The production gate remains
`insufficient-evidence`; the current smoke is not evidence of a native Codex Tool
Search event or a production go decision.

The spike supports initialize, ping, tools/list, catalog discovery, and allowlisted
tools/call through `sando_call`. Other downstream request paths fail closed; auth,
approval, and elicitation are intentionally unsupported and are not propagated.

## Optional provider proxy

The plugin also includes the context/history transformer and an explicit proxy launcher for hosts that support a configured local base URL. The proxy is opt-in and leaves Codex transport untouched unless you point the client at its local URL:

```bash
SANDO_UPSTREAM_URL=https://api.example.test \
SANDO_CONTEXT_POLICY='{"maxHistoryTokens":1000}' \
/path/to/installed/sando/bin/sando-proxy
```

Point the provider client at the printed local URL. The proxy records request-level mechanical metrics; provider cost and turn comparisons still come from paired `apply`/`control` runs.

For the opt-in F1 footprint record, also set `SANDO_CONTEXT_FOOTPRINT_PATH`,
`SANDO_CONTEXT_FOOTPRINT_HOST` (`claude` or `codex`), and an explicit
`SANDO_CONTEXT_SESSION_KEY`. The record contains no request content; without a
session key the initial-context capture is skipped. Set
`SANDO_PROXY_TRANSFORM=0` when the proxy is used only as a capture front-end.
For the local Grafana cockpit, set `SANDO_F1_TELEMETRY=1` and send to the
loopback-only `SANDO_F1_TELEMETRY_ENDPOINT=http://127.0.0.1:4319/v1/logs`;
only coverage and size buckets leave the capture process.

## Project redaction rules

Teams can add project-local detectors in `.sando/redaction.json`:

```json
{
  "schema": "sando-redaction/v1",
  "rules": [
    { "type": "assignment-key", "key": "DATABASE_URL" },
    { "type": "token-prefix", "prefix": "acme_", "minLength": 24, "maxLength": 128 }
  ]
}
```

Built-in detectors remain enabled. The supported declarative rules are `assignment-key` and `token-prefix`; both use the fixed `[REDACTED]` placeholder. The profile is loaded from the current project only, and its digest is recorded in receipts. Invalid profiles are reported instead of silently ignored.

## Telemetry

Telemetry is off by default. The plugin shows a non-blocking reminder until you make a choice. The optional npm library asks once during an interactive install. See the [full disclosure](TELEMETRY.md).
