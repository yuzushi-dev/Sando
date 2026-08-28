# Sando Codex plugin

This directory is the self-contained installable Codex plugin. It includes the hooks, MCP server, CLI, adaptive controller, and optional provider proxy; it does not require the repository package after installation.

The default `apply` arm routes eligible literal reads and searches through bounded local CLI paths. Set `SANDO_ADAPTIVE_ARM=control` for a paired native-control run, using the same `SANDO_ADAPTIVE_EXPERIMENT` and optional `SANDO_ADAPTIVE_WORKLOAD`. After at least three completed sessions per arm, Sando backs off when apply has higher median provider cost or turn count. With missing or invalid evidence it fails open to native routing.

Inspect the current decision with `bin/sando adaptive --json`. The provider ledger is written by the Stop hook. It records provider-reported cache classes, output, cost units, and distinct turns; Sando does not claim mechanical token savings as provider savings.

The provider proxy is explicit opt-in:

```sh
SANDO_UPSTREAM_URL=https://provider.example ./bin/sando-proxy
```

It does not automatically intercept Codex traffic. `sando_exec` remains sandboxed and bounds retained output without terminating the command when the capture limit is reached.
