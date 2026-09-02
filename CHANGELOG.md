# Changelog

## 0.4.2 (candidate)

This release adds measurement and bounded handling for context and tool output. It keeps the experimental paths opt-in and leaves decisions with the operator.

### Added

- F1 context-footprint audit with explicit categories, provenance, and `unavailable` results when the host body is not observable.
- F2 instruction planning with deterministic previews and bounded events for a self-hosted telemetry collector and Grafana.
- F3 result disclosure with redaction, bounded inline output, artifact handles, and bounded recovery where an artifact was admitted.
- F4 lazy MCP gateway with an explicit allowlist, local catalog and call surface, and a kill switch.
- Provider-proxy capture for supported initial context bodies and bounded provider usage evidence.

### Changed

- Claude, Codex, and plugin bundles now share the same generated implementation for the supported surfaces.
- F2 uploads require explicit consent and honor `DO_NOT_TRACK`. Local planning still works when upload is disabled.
- The Codex canary uses the client default model unless `SANDO_CODEX_MODEL` is set.
- Telemetry events use the v2 schema. Mechanical estimates and provider-reported usage remain separate.
- Already queued v1 aggregate rows are preserved and drained during the v2 rollout.

### Fixed

- Oversized redacted results stay within the inline byte limit when artifact admission fails.
- Result and history disclosures identify what was elided and whether recovery is available.
- MCP artifact recovery stays read-only and bounded.

### Boundaries

- F2 Grafana dashboards live in the self-hosted telemetry stack, not in this repository.
- F2 never applies instruction plans automatically.
- F4 stays disabled unless an operator supplies an explicit configuration. Smoke tests do not prove native Tool Search support or production readiness.
