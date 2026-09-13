# sandoichi

`sandoichi` is Sando's optional JavaScript library. The marketplace plugin is the main product. Install the plugin through the Claude Code or Codex marketplace.

```bash
npm install sandoichi
```

```js
import { optimizeToolOutput, createProviderProxy } from 'sandoichi';
```

Project-specific detectors can be declared in `.sando/redaction.json`:

```json
{
  "schema": "sando-redaction/v1",
  "rules": [
    { "type": "assignment-key", "key": "DATABASE_URL" },
    { "type": "token-prefix", "prefix": "acme_", "minLength": 24, "maxLength": 128 }
  ]
}
```

Built-ins stay enabled. Profiles are declarative and local to the current project; invalid profiles fail visibly.

The library requires Node.js `>=22.22.0 <23` and has no runtime dependencies. Installing it does not install or enable the plugin. The plugin remains the supported host surface; this package exports the bounded output/disclosure runtime, context footprint audit, F1/F3/F4 evidence APIs, provider usage report, paired accounting, and explicit proxy API. Host hooks and MCP registration remain outside the package API.

The provider proxy is pass-through unless request transformation is explicitly enabled.

The recoverable-history strategy is opt-in and keeps eligible results inline when they are below 3,072 bytes by default. Provider-boundary replay measurements are diagnostic paired evidence; they do not predict end-to-end agent behavior or provider billing across workloads.

`computeWeightedUsage` and `summarizePairedSessions` keep mechanical reduction, weighted cost units, and paired-session evidence separate from the provider-usage report's reported cost provenance and coverage. Host-reported list estimates are not billed-cost records. The library does not install hooks, register MCP servers, or make routing/backoff decisions for a host.

For plugin installation, see the [main project README](https://github.com/yuzushi-dev/Sando#readme).

Telemetry is off by default. An interactive npm install asks once for consent; see the [full disclosure](https://github.com/yuzushi-dev/Sando/blob/main/TELEMETRY.md).

License: MIT.
