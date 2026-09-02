# Sando Codex plugin

This directory contains the self-contained Codex plugin. It bundles the hooks, MCP server, CLI, paired accounting, and optional provider proxy; it does not require the repository package after installation.

The default `apply` arm routes eligible literal reads and searches through bounded local CLI paths. Set `SANDO_EXPERIMENT_ARM=control` for a paired native-control run, using the same `SANDO_EXPERIMENT` and optional `SANDO_EXPERIMENT_WORKLOAD`. Control/treatment selection is explicit, and provider usage does not change routing.

Inspect the provider report with `bin/sando accounting --json`. The Stop hook writes the provider ledger. It records cache classes, output, reasoning, distinct turns, and provider cost only when the host reports it. Mechanical context trimming and weighted estimates remain separate.

Run the capture-based, read-only context audit with `bin/sando context audit --host codex --input capture.json --json`. Without an explicit capture, it reports `unavailable`; it does not infer host-owned prompt categories from provider totals.

Evaluate a redacted numeric gateway evidence file with `bin/sando context gateway-gate --input gateway-evidence.json --json`. The command only reports `go`, `no-go`, or `insufficient-evidence`; it never changes MCP configuration or enables a gateway.

Large result previews expose `sando-result-disclosure/v1`; use the read-only `sando_artifact_get` MCP tool or `bin/sando artifact get --root . --ref sando:sha256:...` for bounded redacted recovery. The Lazy MCP Gateway remains gated until native Tool Search paired evidence exists.

The provider proxy is explicit opt-in:

```sh
SANDO_UPSTREAM_URL=https://provider.example ./bin/sando-proxy
```

Set `SANDO_CONTEXT_FOOTPRINT_PATH`, `SANDO_CONTEXT_FOOTPRINT_HOST`, and
`SANDO_CONTEXT_SESSION_KEY` to enable the content-free F1 record for that proxy
process. Set `SANDO_PROXY_TRANSFORM=0` for capture-only forwarding. Missing
session keys fail closed; normal Codex traffic is unchanged.

It does not intercept Codex traffic unless configured. `sando_exec` remains sandboxed and bounds retained output without terminating the command when the capture limit is reached. MCP adds a model-visible tool interaction; use the native PreToolUse route where applicable and measure the tradeoff per workload.
The optional provider proxy reports history elisions as digest-only `sando-history-disclosure/v1` records; history errors and current/batch results are never compacted.
