<p align="center">
  <img src="assets/sando-mark.png" alt="Sando logo" width="96">
</p>

# Sando

Sando is a local plugin for Claude Code and Codex. It keeps repeated and oversized tool output under control, preserves complete artifacts when needed, and provides bounded local tool surfaces. It runs locally and makes no LLM calls.

## Install the plugin

Install the plugin through the host marketplace. The package includes its hooks and bundles, so the setup has no build step.

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

After installation, Sando's hooks, MCP server, bounded tool commands, artifacts, adaptive provider ledger, and status reporting are available through the host. The plugin bundle is self-contained; the optional npm package is not required.

## Adaptive cost control

The normal arm is `apply`. Sando records provider-reported input, cache-read, cache-write, output, and turn counts at session stop. It keeps literal CLI routing enabled until both arms have enough evidence, then backs off automatically when the `apply` median cost or turn count exceeds `control` by the configured tolerance.

Run a control session with the plugin still installed but routing disabled:

```bash
SANDO_ADAPTIVE_EXPERIMENT=read-heavy \
SANDO_ADAPTIVE_ARM=control \
codex
```

Normal sessions use `SANDO_ADAPTIVE_ARM=apply` (the default). Use the same `SANDO_ADAPTIVE_EXPERIMENT` and workload when comparing arms. Inspect the current decision with the installed plugin's `bin/sando` launcher:

```bash
/path/to/installed/sando/bin/sando adaptive --json
```

The decision is based on provider usage and turns, not on estimated bytes or tokens removed from a tool result. With incomplete evidence it remains enabled but reports `insufficient-evidence`; it never claims savings from that state. Override the defaults with `SANDO_ADAPTIVE_MIN_SESSIONS` and `SANDO_ADAPTIVE_TOLERANCE`.

The statusline shows provider tokens, turns, cache-aware cost units, and—when the host supplies a real session cost—the effective `$ / M` rate. It does not present mechanical reduction as provider savings.

## Optional provider proxy

The plugin also ships the existing context/history transformer and an explicit proxy launcher for hosts that support a configured local base URL. It is opt-in and does not intercept or rewrite Codex transport automatically:

```bash
SANDO_UPSTREAM_URL=https://api.example.test \
SANDO_CONTEXT_POLICY='{"maxHistoryTokens":1000}' \
/path/to/installed/sando/bin/sando-proxy
```

Point the provider client at the printed local URL. The proxy records request-level mechanical metrics; provider cost and turn comparisons still come from paired `apply`/`control` ledger sessions.

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
