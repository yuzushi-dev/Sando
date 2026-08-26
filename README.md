# Sando

Sando reduces repeated tool-output context in Claude Code and Codex. It runs locally and makes no LLM calls.

## Install the plugin

Claude Code:

```text
/plugin marketplace add yuzushi-dev/yuzushi-plugins
/plugin install sando@yuzushi
```

Codex:

```bash
codex plugin marketplace add yuzushi-dev/yuzushi-plugins
```

Then run `/plugins` and install `sando`.

## Install the npm package

```bash
npm install sandoichi
```

The npm package is the library. It does not install the plugin.

## Telemetry

Telemetry is off by default. npm install asks once; plugin installs show a reminder until you choose.
