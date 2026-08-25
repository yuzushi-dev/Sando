# Sando core

Dependency-free ESM for deterministic tool-output preparation and local savings metrics on Node 22. The core performs no writes, network access, or LLM calls.

## API

```js
import { estimateTokens, optimizeToolOutput } from './index.mjs';

const result = optimizeToolOutput({
  toolName: 'Read',
  output,
  cwd: process.cwd(),
  policy: {
    mode: 'apply',
    maxInlineBytes: 4096,
    maxColumns: 768,
    redact: true,
  },
});
```

`optimizeToolOutput({ toolName, output, cwd, policy })` returns `{ inline, artifact?, route, reason, stats }`.

- `output` may be text or a JSON value; JSON is serialized deterministically.
- Small output stays inline. Larger output gets a bounded head/tail view with middle elision and an optional complete redacted artifact.
- `artifact.content` is returned to the caller; the core does not persist it. `artifact.ref` is content-addressed.
- Common `Authorization`, API key, access-token, password, secret, and private-key fields are redacted by default.
- `mode` accepts `apply`, `dry-run`, or `observe`. It is recorded in `stats`; it does not change the deterministic candidate.
- `route` records the selected tool policy (`passthrough`, `structured`, `artifact`, or eligible `summary`). Routing metadata is not a claim that a host can intercept a built-in result.
- An unselected `Read` with at least 100 lines and at most 2 MiB gets a structural outline only when the outline is smaller; the full redacted observed output remains recoverable as an artifact. Hook events derive these bounds from the observed result and preserve explicit line selectors/raw reads.
- `Grep` uses the OMP-compatible bounds (20 files, 20 matches per file for multi-file searches, 200 for one file, 4 MiB per file, 512-byte columns). Bash output also collapses runs of identical non-empty lines with an explicit count before applying the head/tail budget.

`estimateTokens(text)` returns `ceil(UTF-8 bytes / 4)`. It is a deterministic local estimate for comparisons, not provider tokenization or billable usage. `stats` reports exact byte counts and local estimates; it never infers provider savings.

Hook sessions can set `SANDO_OBSERVE_ONLY=1` (also `true` or `yes`) to force observation even when `SANDO_MODE` or `SANDO_POLICY.mode` says `apply`. The hook then records the candidate estimate without replacing the host tool result.

Additional exports are `normalizeEvent`, `normalizePolicy`, and `createReceipt`. Receipts contain digests and deterministic stats, not raw output.

## Metrics

Hooks persist redacted numeric records at `$XDG_STATE_HOME/sando/metrics.json`, or `~/.local/state/sando/metrics.json` when `XDG_STATE_HOME` is unset. Set `SANDO_METRICS_PATH` to an absolute path to override it.

```sh
node packages/sando/src/metrics-cli.mjs
node packages/sando/src/metrics-cli.mjs --json
```

The JSON report is `sando-report/v1`. `estimatedTransformSavingsTokens` is based on the local byte estimate. `providerReportedSavingsTokens` is `null` unless paired provider counters are supplied.

`src/provider-ledger.mjs` is separate accounting infrastructure for provider prompt/output and cache-read/cache-write counters. It does not calculate savings or parse provider-native responses.

`src/provider-usage.mjs` is the persisted provider transcript ledger (`sando-provider-usage/v1`). It stores numeric Claude/Codex usage only, deduplicates repeated Stop hooks, and keeps provider input/output/cache counters separate from local transform estimates. The default file is `~/.local/state/sando/provider-usage.json`; override it with the absolute `SANDO_PROVIDER_USAGE_PATH`.

`src/statusline.mjs` renders compact local savings (`k`/`M`) and an estimated dollar value when the selected model's standard input price is known. Provider input/output/cache counters remain in the provider ledger but are omitted from the statusline. Claude receives its session from the native statusline input; Codex resolves it from the tmux-pane marker in `src/active-session.mjs`. A missing or replaced session renders a safe empty state; historical records are not shown as `stale`.

`npm run sync:bundles` copies the canonical core, routing, and active-session modules into the standalone Claude/Codex/plugin bundles; the bundle-parity test fails if they drift.

## Deterministic provider proxy

`transformProviderRequest()` rewrites only safe historical tool results in Anthropic Messages, OpenAI Chat Completions, and OpenAI Responses bodies. It supersedes older repeated `Read` results, deduplicates exact historical `Read`/`Grep`/`Bash` results, compacts repeated lines in historical Bash/log output, and can extractively shake large historical Bash/Grep/log results into head/tail/high-signal views when the budget is exceeded. It elides recognizable useless successes; errors, IDs, order, current results, and ambiguous shapes are preserved. It makes no LLM calls.

The optional loopback proxy forwards JSON requests and streaming responses while applying that transform:

```sh
SANDO_UPSTREAM_URL=https://api.anthropic.com SANDO_PROXY_PORT=8787 npm run proxy
ANTHROPIC_BASE_URL=http://127.0.0.1:8787 claude --plugin-dir "$PWD/adapters/claude/sando"
```

The proxy is opt-in, loopback-only by default, requires an explicit upstream, and never logs request bodies or credentials. Set `SANDO_CONTEXT_POLICY='{"maxHistoryTokens":120000}'` to gate the extra deduplication, repeated-line reductions, and extractive history shake at 80% of the request budget; the safe repeated-`Read` pass remains active without that setting. The shake is not a semantic summary: it preserves selected head/tail/high-signal lines and tells the model to rerun the tool if needed. Its local token counts are estimates; provider-reported savings still require paired A/B counters. The host's raw UI/transcript may still retain the original result: the proxy guarantees model-request reduction, not transcript redaction.

A rewrite that would invalidate a warm provider cache is skipped unless it reclaims enough of the suffix to pay for the cache-write it forces (`policy.cacheRewriteRatio`, default 0.51), or unless the request has been idle long enough (`policy.cacheIdleFlushMs`, default 65 min, past Anthropic's longest published cache TTL) that the cache is cold on its own, in which case the guard is skipped for free.

Semantic compaction is exposed as a shadow-only API. Inject a completion adapter into `createSemanticCompactor()` or the proxy to evaluate safe historical candidates. Sando redacts the prompt boundary, requires `sando-semantic-summary/v1`, validates required-fact recall and output ratio, caches only validated summaries, and fails open on timeout or invalid output. The result is telemetry only; the provider request is unchanged until a separately approved apply path exists.

For Codex, point `base_url` at the loopback root (without `/v1`). Use `https://chatgpt.com/backend-api/codex` as the upstream with ChatGPT OAuth, or `https://api.openai.com/v1` with an API key.

Codex can target the proxy through a custom `model_providers.<id>.base_url` using `wire_api = "responses"`; do not edit provider configuration automatically. See the host adapter READMEs for examples.

## Test

```sh
node --test packages/sando/tests/*.test.mjs
```
