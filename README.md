<p align="center">
  <img src="assets/sando-mark.png" alt="Sando logo" width="96">
</p>

# Sando

Sando is a local plugin for Claude Code and Codex. It keeps repeated and oversized tool output under control, preserves complete artifacts when needed, and provides bounded local tool surfaces. It runs locally and makes no LLM calls.

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

Each host wires only the hooks and MCP surfaces declared by its manifest. The remaining bundled CLI, proxy, statusline, metrics, and accounting launchers are manual entrypoints; see the [shipping matrix](docs/shipping-matrix.md). The bundle is self-contained; the optional npm package is not required.

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

## Optional provider proxy

The plugin also includes the context/history transformer and an explicit proxy launcher for hosts that support a configured local base URL. The proxy is opt-in and leaves Codex transport untouched unless you point the client at its local URL:

```bash
SANDO_UPSTREAM_URL=https://api.example.test \
SANDO_CONTEXT_POLICY='{"maxHistoryTokens":1000}' \
/path/to/installed/sando/bin/sando-proxy
```

Point the provider client at the printed local URL. The proxy records request-level mechanical metrics; provider cost and turn comparisons still come from paired `apply`/`control` runs.

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
