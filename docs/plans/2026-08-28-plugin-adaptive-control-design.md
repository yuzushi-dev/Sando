# Sando Plugin Adaptive Control Design

**Decision:** The installable Codex plugin is the product surface. The npm package and provider proxy remain optional integrations, but the plugin bundle must contain the runtime and measurement code it advertises.

## Scope

The plugin will:

- keep deterministic `PreToolUse` CLI routing as the only transparent Codex path;
- ship the provider-context modules and a documented proxy launcher for hosts that support a configured local base URL;
- persist provider-reported input/cache/output counters with an explicit `apply` or `control` arm;
- gate Sando routing from rolling provider cost and turn observations;
- fail open when evidence is missing, malformed, or below the minimum sample size.

The plugin will not claim that Codex PostToolUse can replace output already delivered by a built-in tool. It will not turn byte/token reduction into a provider-savings claim.

## Adaptive decision

Each completed session is reduced to numeric observations: provider, arm, experiment, session, weighted cache-aware cost units, and turn count. Cost units use provider-relative weights for fresh input, cache reads, cache writes, output, and reasoning output. They are explicitly not dollars unless a provider supplies prices.

For an experiment with at least three control and three apply sessions, compare median session cost and median turns. Disable routing when apply cost or turns exceed control by the configured tolerance. With insufficient evidence, allow routing and report `insufficient-evidence`; no savings claim is emitted. A control session is an `SANDO_ADAPTIVE_ARM=control` run with the plugin installed but routing disabled, which preserves the same transcript and recorder surface.

## Data flow

`PreToolUse` refreshes the provider ledger from the available transcript, evaluates the adaptive gate, then either applies the existing literal CLI rewrite or returns the existing bypass. `Stop` refreshes the same ledger with the final transcript. The provider usage schema remains numeric-only and backward-compatible; optional arm/experiment/workload fields are attached only to new adaptive records.

The proxy and context transformer are copied into the plugin bundle by the existing sync script. They remain opt-in because Codex cannot be configured for a custom provider base URL by a plugin manifest alone.

## Failure and privacy

All adaptive reads and writes are best-effort. A corrupt ledger, missing transcript, unknown arm, or invalid policy disables adaptive routing for that invocation rather than blocking the host. No prompts, tool output, headers, or response bodies enter the adaptive ledger.

## Verification

Pure tests cover weighted cost, cohort comparison, insufficient evidence, cost/turn backoff, and malformed data. Bundle parity tests verify that the plugin contains the same canonical provider and transform modules. Hook tests verify control mode, apply mode, transcript refresh, and fail-open behavior.
