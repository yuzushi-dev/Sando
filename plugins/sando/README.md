# Sando Codex plugin

This directory is the self-contained installable Codex plugin. It includes the hooks, MCP server, CLI, paired accounting, and optional provider proxy; it does not require the repository package after installation.

The default `apply` arm routes eligible literal reads and searches through bounded local CLI paths. Set `SANDO_EXPERIMENT_ARM=control` for a paired native-control run, using the same `SANDO_EXPERIMENT` and optional `SANDO_EXPERIMENT_WORKLOAD`. Control/treatment selection is explicit; provider usage does not automatically change routing.

Inspect the provider report with `bin/sando accounting --json`. The Stop hook writes the provider ledger. It records cache classes, output, reasoning, distinct turns, and provider cost only when the host reports it. Mechanical context trimming and weighted estimates remain separate.

The provider proxy is explicit opt-in:

```sh
SANDO_UPSTREAM_URL=https://provider.example ./bin/sando-proxy
```

It does not automatically intercept Codex traffic. `sando_exec` remains sandboxed and bounds retained output without terminating the command when the capture limit is reached. MCP adds a model-visible tool interaction; use the native PreToolUse route where applicable and measure the tradeoff per workload.
