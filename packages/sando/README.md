# sandoichi

`sandoichi` is Sando's optional JavaScript library. The full Sando plugin is the main product. Install it through the Claude Code or Codex marketplace.

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

The library requires Node.js `>=22.22.0 <23` and has no runtime dependencies. Installing it does not install or enable the plugin.

For plugin installation, see the [main project README](https://github.com/yuzushi-dev/Sando#readme).

Telemetry is off by default. An interactive npm install asks once for consent; see the [full disclosure](https://github.com/yuzushi-dev/Sando/blob/main/TELEMETRY.md).

MIT.
