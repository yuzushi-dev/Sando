# Sando Codex plugin

This directory contains the self-contained Codex plugin. It bundles the hooks, MCP server, CLI, paired accounting, and optional provider proxy; it does not require the repository package after installation.

Transparent CLI routing is on by default: eligible commands are routed through bounded local CLI paths, and everything else is wrapped so its output is bounded. Set `SANDO_CLI_ROUTING=0` to opt out. Set `SANDO_EXPERIMENT_ARM=control` for a paired native-control run, using the same `SANDO_EXPERIMENT` and optional `SANDO_EXPERIMENT_WORKLOAD`.

Inspect the provider report with `bin/sando accounting --json`. The Stop hook writes the provider ledger. It records cache classes, output, reasoning, distinct turns, and host-reported cost only when the host reports it, with source and coverage preserved. A host-reported list estimate is not a billing record. Mechanical context trimming and weighted estimates remain separate.

Run the capture-based, read-only context audit with `bin/sando context audit --host codex --input capture.json --json`. Without an explicit capture, it reports `unavailable`; it does not infer host-owned prompt categories from provider totals.

Evaluate a redacted numeric gateway evidence file with `bin/sando context gateway-gate --input gateway-evidence.json --json`. The command only reports `go`, `no-go`, or `insufficient-evidence`; it never changes MCP configuration or enables a gateway.

Large result previews expose `sando-result-disclosure/v1`; use the read-only `sando_artifact_get` MCP tool or `bin/sando artifact get --root . --ref sando:sha256:...` for bounded redacted recovery. The Lazy MCP Gateway remains gated until native Tool Search paired evidence exists.

The provider proxy is explicit opt-in:

```sh
SANDO_UPSTREAM_URL=https://provider.example SANDO_PROXY_TRANSFORM=1 ./bin/sando-proxy
```

Set `SANDO_CONTEXT_FOOTPRINT_PATH`, `SANDO_CONTEXT_FOOTPRINT_HOST`, and
`SANDO_CONTEXT_SESSION_KEY` to enable the content-free F1 record for that proxy
process. Transformation is pass-through by default and requires
`SANDO_PROXY_TRANSFORM=1`. Missing
session keys fail closed; normal Codex traffic is unchanged.

To measure preview quality with TypeSafe/Jev, install the optional `pi-typesafe` package in the
launcher environment and set `SANDO_TYPESAFE_SHADOW=1` together with `SANDO_PROXY_TRANSFORM=1`.
Only redacted, bounded samples of
historical successful results and their previews are judged. The verdict is shadow-only: the
provider request is unchanged. Missing package or key disables the judge; use `SANDO_PROJECT_ROOT`
for project-local `.sando/redaction.json` rules.

The offline semantic-quality test compares labeled diagnostic facts before and after a loss gate;
it uses an injected judge and does not gate live provider requests.

It does not intercept Codex traffic unless configured. `sando_exec` remains sandboxed and bounds retained output without terminating the command when the capture limit is reached. MCP adds a model-visible tool interaction; use the native PreToolUse route where applicable and measure the tradeoff per workload.
The optional provider proxy reports history elisions as digest-only `sando-history-disclosure/v1` records; opaque OpenAI results without explicit success evidence, known errors, and current/batch results remain lossless. Historical transform families have independent policy switches.

Recoverable history is opt-in and skips eligible results below 3,072 bytes by default. Same-transcript provider replays show conditional input reduction; natural client trajectories remain workload-dependent, so the plugin does not advertise a general savings percentage.


## Optional: TypeSafe AI Supervised Guards (Done-Check & Stuck-Loop)

Sando supports optional semantic supervision powered by TypeSafe AI (System One model Jev) to protect against unverified completion claims and repetitive retry loops:

- **Done-Guard:** Intercepts turn completions where code was modified but no passing test command was recorded by Sando telemetry, preventing unverified completion claims from closing tasks prematurely.
- **Stuck-Guard:** Detects consecutive tool failures. Identical failures are intercepted deterministically at Tier 1 (0 ms, 0 API calls). Ambiguous variations of failing strategies are evaluated by Jev at Tier 2.

### Configuration (Option B: User Home Configuration)

Users configure their personal API key in their private home directory (`~/.config/typesafe/auth.json`), keeping keys strictly outside of repository working trees:

```bash
mkdir -p ~/.config/typesafe
cat << 'EOF' > ~/.config/typesafe/auth.json
{
  "api_key": "YOUR_PERSONAL_TYPESAFE_KEY"
}
EOF
chmod 600 ~/.config/typesafe/auth.json
```

Alternatively, set the `TYPESAFE_API_KEY` environment variable. Verify the setup anytime by running `node plugins/sando/bin/verify-typesafe-live.mjs`.

### Privacy & Fail-Open Semantics
- **Zero credential leaks:** Both state and question payloads undergo bidirectional secret redaction (`[REDACTED]`) locally before any network transmission.
- **Strict Fail-Open:** If unconfigured, unreachable, or timed out (>1500 ms), guards automatically degrade to local deterministic heuristics without blocking the session or throwing unhandled errors.
