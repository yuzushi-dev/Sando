# Sando shipping matrix

Use this matrix to see which files each install path wires automatically.
It is the source for install claims in the public README.

| Surface | Install entrypoint | Wired automatically | Present but manual/optional | Not installed by this path |
| --- | --- | --- | --- | --- |
| Claude Code marketplace | `/plugin install sando@yuzushi` | Claude companion hooks (`SessionStart`, `UserPromptSubmit`, `PostToolUse`, `Stop`) | Bundled MCP server, audit/planner/gateway-gate/artifact recovery, provider proxy, statusline wrapper, metrics and accounting launchers | Codex plugin manifest and Codex MCP registration |
| Codex marketplace | `codex plugin marketplace add yuzushi-dev/yuzushi-plugins`, then enable `sando` | Codex companion hooks, declared Sando MCP server including `sando_exec`, bounded CLI routes | Audit/planner/gateway-gate/artifact recovery, provider proxy, statusline/metrics/accounting launchers | Claude plugin manifest and Claude statusline registration |
| npm `sandoichi` | `npm install sandoichi` | JavaScript library exports only; optional postinstall telemetry consent | Call exported transforms, reports, and proxy APIs from application code | Host hooks, MCP server registration, marketplace plugin launchers |

## Before/after claim corrections

| Old implication | Factual replacement |
| --- | --- |
| Marketplace installation wires every bundled Sando surface on every host. | Each marketplace manifest wires only the hooks and MCP surfaces declared by that host; the matrix above names the rest as manual. |
| Sando automatically adapts routing after comparing apply/control sessions. | Sando records provider usage and exposes deterministic paired accounting. Apply/control are explicit experiment arms; routing backoff is future work. |
| Mechanical bytes/tokens removed are provider savings. | Mechanical context trimmed is reported separately. Billed cost is shown only when the provider or host reports it; otherwise the report says unavailable and may show a weighted token estimate. |
| npm installation installs an agent plugin. | `sandoichi` is a library. It does not install hooks, MCP registration, or marketplace launchers. |

The Codex native PreToolUse route is preferred for eligible literal reads and
searches because it avoids an extra model-visible MCP tool call. MCP remains
useful for explicit bounded operations such as `sando_exec`; its turn/tool-call
tradeoff must be measured per host, model, and workload.

## Feature boundaries

| Feature | Automatic boundary | Manual/optional boundary | Current evidence limit |
| --- | --- | --- | --- |
| F1 context footprint | None beyond explicitly configured capture/proxy hooks | Capture and provider-proxy telemetry are opt-in | Reports separate mechanical estimates from provider-reported usage; unavailable host bodies stay unavailable |
| F2 instruction disclosure | No plan application | Runner, self-hosted telemetry/Grafana, previews, and fixed human labels | Preview-only; upload requires consent and honors `DO_NOT_TRACK` |
| F3 result disclosure | Bounded hook/MCP output on wired host surfaces | Artifact byte/line recovery and provider proxy | Oversized artifacts over the admission cap have bounded previews with no complete-artifact claim |
| F4 lazy MCP gateway | None; gateway is disabled by default | Explicit config, process, allowlist, and local ledger | Smoke/gateway evidence is not native Tool Search evidence or a production go decision |
