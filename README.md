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

After installation, Sando's hooks, MCP server, bounded tool commands, artifacts, and status reporting are available through the host.

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
