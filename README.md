<p align="center">
  <img src="assets/sando-mark.png" alt="Sando logo" width="96">
</p>

# Sando

Sando is a context-management plugin for Claude Code and Codex. It bounds what a tool result
costs before that result reaches the model. Large output is truncated to a cap set by the kind
of content it is, the full bytes are kept on disk with a verified hash, and the lines that
answer the question are pulled out of the part that was cut, including error lines and test
totals.

On Codex that means 90.9% less shell output, measured over 40,000 recorded results. On a
repository, roughly 2.4x as many files fit into a 200,000-token window. Every figure below is
reproducible with a command, against your own corpus.

It acts on tool results only, so it composes with whatever else you run to keep a session
small, such as output filters or scope rules, without competing for the same step.
Deterministic local transforms make no LLM calls.

A separate, opt-in experiment archives older tool observations across turns and leaves
recoverable references in the active history. Controlled provider-boundary replays reduced
reported input by 28.5% on Codex and effective input by 42.4% on Claude, while natural pilots
ranged from a 45.3% reduction to a 55.7% increase. Those replays show a conditional mechanism
and are not a billing claim.

The package also contains earlier output filters, artifact tools and Slice integration, each evaluated separately from the experiment above.

Release notes: [Sando 0.5.0](docs/changelogs/0.5.0.md).

Development branch: `release/0.5.0`.

## Slice: symbol reads and opt-in writes

Slice connects Sando's MCP to a separately built native symbol engine. Build the
tested engine from a Sando source checkout with Bash, Git, Make, CMake 3.24+ and GCC 13+
(C and C++ compilers). The verified target is Ubuntu 24.04 on Linux x86-64;
other operating systems, architectures and toolchains are not verified by Sando.

```bash
# Run from the Sando checkout. The destination must not already exist.
bash scripts/build-slice.sh "$HOME/sando-slice"
```

The script fetches [upstream source at commit
`d90acb2cb3295da8ca0fd33a88e81cb51a8575fb`](https://github.com/redhat-et/ripwire/tree/d90acb2cb3295da8ca0fd33a88e81cb51a8575fb),
checks the revision and builds with vendored dependencies and CMake downloads
disabled. It retains the source and its licenses, refuses an existing destination,
and leaves a failed build in place for diagnosis. Expect several minutes of
compilation, several GB of RAM, and space for the source and build tree. It does not install hooks,
modify host configuration or install a binary globally.

Build on the machine where the MCP server runs: the executable uses that system's
C/C++ runtime libraries. This is a pinned source build, not a promise of identical
binary bytes across compilers or portability to older distributions. The native
engine is Apache-2.0, with dependency notices in its `THIRD_PARTY.md` and
`third_party/` license files; Sando's JavaScript remains MIT. Keep those notices
with any redistributed native artifact. The plugin and npm library contain no
native executable.

Configure the MCP server environment with the resulting absolute executable path
and a canonical workspace directory:

```bash
SANDO_SLICE_BINARY=/absolute/path/to/sando-slice/build/ripwire
SANDO_SLICE_ROOT=/absolute/path/to/workspace
SANDO_SLICE_WRITE=1
```

Without a valid binary and root, no Slice tools are advertised. Omit
`SANDO_SLICE_WRITE` for read-only use. Codex runs the engine inside the host's
managed restricted sandbox; missing sandbox metadata is refused.

Read tools are `sando_slice_for`, `sando_slice_find_symbol`,
`sando_slice_find_referencing_symbols`, and `sando_slice_fetch_body` (at most 400
body-relative lines per call). Writes are `sando_slice_replace_symbol_body` and
`sando_slice_insert_after_symbol`.

Find the symbol, fetch its body, then pass its `sym#…@…` identifier as the write's
`handle`. Plain names are not accepted for writes. Replacement covers exactly
the fetched definition span: preserve modifiers such as `export` that sit
outside it instead of adding them again. Stale handles are refused; read again
and reconsider the edit. Insertion before a definition is not exposed.

Slice applies Sando's project redaction rules to results and errors. Redacted
source is marked as non-round-trippable and its handle cannot be used for replacement.
The engine's handles, freshness metadata, and edit receipts are otherwise preserved.
`post_check` provides static feedback, not a test run; run project tests after
editing. If a write is interrupted or loses its response, inspect the file
before retrying: cancellation does not imply rollback.

Native integration checks use temporary workspaces. The Codex cases additionally
require the Codex CLI on `PATH` and a working host sandbox (Bubblewrap on Linux);
they are skipped when Codex is absent. CI provides both and runs every native case:

```bash
SANDO_SLICE_TEST_BINARY="$HOME/sando-slice/build/ripwire" npm test
```

Bash previews also remove ANSI formatting and retain bounded error diagnostics
from omitted output, prioritizing failures over warnings. Full admitted
artifacts retain the original redacted output; ANSI formatting is also removed
there when necessary to redact a credential split by escape sequences.

## Install the plugin

Install Sando from the host marketplace. Each marketplace source includes its hooks and bundles, so installation needs no build step.

### Requirements

- Claude Code or Codex
- Node.js `>=22.22.0 <23`, with `node` available in `PATH`

Check the Node version with:

```bash
node --version
```

### Claude Code

Run these commands in Claude Code:

```text
/plugin marketplace add yuzushi-dev/yuzushi-plugins
/plugin install sando@yuzushi
```

### Codex

Add the marketplace:

```bash
codex plugin marketplace add yuzushi-dev/yuzushi-plugins
```

Then open `/plugins`, select `sando`, and install/enable it. Start a new session if Codex was already open.

Each host wires only the hooks and MCP surfaces declared by its manifest. The remaining bundled CLI, audit, artifact recovery, proxy, statusline, metrics, and accounting launchers are manual entrypoints. The bundle is self-contained; the optional npm package is not required.

## Provider accounting and paired controls

Sando records provider-reported input, cache-read, cache-write, output, reasoning, and turn counts at session stop. It also records mechanical context trimming separately. A weighted token estimate is diagnostic; provider cost and blended rates are shown only when the provider or host reports them.

Run an explicit control session with the plugin still installed:

```bash
SANDO_EXPERIMENT=read-heavy \
SANDO_EXPERIMENT_ARM=control \
codex
```

Treatment sessions use `SANDO_EXPERIMENT_ARM=apply` and must opt into transparent CLI routing with `SANDO_CLI_ROUTING=1`. Use the same experiment and optional `SANDO_EXPERIMENT_WORKLOAD` for both arms. Generate the accounting report from the installed Codex plugin:

```bash
/path/to/installed/sando/bin/sando accounting --json
```

The paired report exposes control/treatment cache classes, output and reasoning tokens, model turns, native/Sando tool calls, mechanical bytes, and weighted cost units. The separate provider-usage report exposes reported USD cost with its coverage and source when available; a host-reported list estimate is not a billing record. Replay results are marked counterfactual, and mechanical reduction is never turned into a provider-billing claim.

The statusline shows mechanically estimated context tokens saved and its reduction percentage. A leading `~` marks the estimate. Provider usage remains available through the accounting report; provider savings are not rendered as a percentage because their denominator is not comparable to the mechanical estimate.

## Context footprint audit

The read-only audit measures an explicitly captured initial-context body for Claude Code or Codex. It attributes observable bytes to host/project instructions, skills, built-in tools, direct/deferred MCP, Sando, history, prompt, provider overhead, and `unknown`. It never uses provider totals to invent a category breakdown. If the host body is not exposed, the result is `unavailable`.

Run it from an installed Codex bundle:

```bash
/path/to/installed/sando/bin/sando context audit --host codex --input capture.json --json
```

The Claude bundle exposes the same command through `node context-audit.mjs`:

```bash
node /path/to/installed/sando/context-audit.mjs context audit --host claude --input capture.json --json
```

Without a capture it reports the honest boundary:

```bash
/path/to/installed/sando/bin/sando context audit --host claude
```

Capture files use `sando-context-capture/v1`. They contain byte counts or ephemeral content for classified segments; reports retain only numeric totals and provenance digests, never paths, prompts, or secrets. Mechanical token estimates (`ceil(UTF-8 bytes / 4)`) and provider-reported usage are separate evidence classes.

## Lazy MCP Gateway

Evaluate the explicit Lazy MCP Gateway gate from a redacted, numeric evidence file:

```bash
/path/to/installed/sando/bin/sando context gateway-gate --input gateway-evidence.json --json
# Claude bundle: node /path/to/installed/sando/gateway-gate.mjs context gateway-gate --input gateway-evidence.json --json
```

The evidence schema is `sando-progressive-gateway-evidence/v1`. The evaluator
requires native Tool Search control data, both hosts, ten paired samples and 50
discovery intents per host, isolated original MCPs, unchanged digests,
provider-reported metrics, a read-only allowlisted catalog, tested rollback, and
the explicit safety/quality thresholds. Missing evidence stays
`insufficient-evidence`; no gateway is enabled by this command.

The evaluator validates the supplied redacted summary structurally; its digest is
an integrity checksum, not authentication of provider provenance. A `go` result is
not authorization to build or enable the gateway unless the summary is traced back
to the authorized paired runner outputs.

## What it saves

On Codex, with `SANDO_CLI_ROUTING=1` set, Sando bounds the output of every shell command before
it reaches the model. Across more than 40,000 recorded results that is 78.5M tokens of shell
output reduced to 7.2M, or 90.9%.

```bash
node scripts/bench-codex-shell.mjs     # the same measurement against your own rollouts
```

The bytes are kept, not dropped. The full content is written to disk with a verified hash and
the bounded result carries the command to fetch back whatever was cut, for any result up to the
1 MiB artifact limit. Beyond that, and beyond the 16 MiB a wrapped command captures, the excess
is truncated at the source and marked as such.

Here is what that looks like on one command. `npm test` in this repository prints 573 test
results across two summary blocks, 120 KB in total. Bounded, the model sees 4 KB and still
answers *573 passed, 0 failed*, because the totals are pulled out of the elided middle along
with any error lines. Before that salvage existed, the same model read the surviving block and
answered *100 passed*, with nothing to mark the omission.

On Claude the `PostToolUse` hook bounds tool results without touching how commands run, and the
optimiser removes 14.5% to 18.9% of that output across two machines. Results from external
`mcp__*` tools pass through untouched and are excluded from those figures.

On either host, reading files rather than running commands, about 2.4x as many files fit into a
200,000-token window. Run `node scripts/bench-reduction.mjs` against any git checkout for the
exact counts on that corpus; the ratio has held between 2.39x and 2.44x across every commit of
this repository, while the file counts move with whatever the commit contains.

These are output reductions, one tool result at a time. What a session costs also depends on
prompt-cache economics, which these numbers do not model. Method, per-corpus variation and the
measurements behind every number are in [`docs/measurements.md`](docs/measurements.md).

## Result progressive disclosure

The library and MCP result APIs expose a bounded preview plus a `sando-result-disclosure/v1` record. The record contains redacted byte counts, provenance, elision markers, and a digest handle; it never contains the full payload. Claude and Codex hook responses remain host-native and do not include disclosure metadata. Recover a bounded byte or line range from an installed workspace artifact with:

```bash
/path/to/installed/sando/bin/sando artifact get --root . --ref sando:sha256:... --start-line 1 --end-line 40 --json
# Claude bundle: node /path/to/installed/sando/artifact.mjs artifact get --root . --ref sando:sha256:... --json
```

`maxArtifactBytes` is an admission limit, not a truncation target. If the complete
redacted result exceeds it, Sando keeps only a bounded preview, does not issue an
artifact handle, and marks recovery unavailable instead of pretending a partial
artifact is complete.
On artifact writes, Sando removes entries older than seven days and caps retained
artifacts at 64 MiB. Cleanup only removes regular content-addressed files and never
follows symlinks.

MCP results expose the read-only `sando_artifact_get` tool for artifacts kept in that MCP process. Claude PostToolUse and Codex artifact paths preserve their existing host boundaries; errors, current results, IDs, order, batches, and binary status remain untouched.

The opt-in provider proxy also emits `sando-history-disclosure/v1` metadata for history elisions: each change has digest/byte accounting and explicitly says whether to rerun the tool or use the newer result. Proxy history is not falsely advertised as an MCP artifact.

The Lazy MCP Gateway spike is implemented but disabled by default. It is a replacement
surface for explicitly allowlisted external MCP servers, not a wrapper around host
built-ins. Configure `SANDO_MCP_GATEWAY_CONFIG` with JSON (or an explicit JSON file
path) containing `enabled`, `allowlist`, and `servers` entries with `command`/`args`,
then run `node packages/sando/gateway.mjs`. Do not expose the same MCPs through the
host at the same time. Roll back by stopping this process and removing the gateway
MCP entry; setting `enabled: false` is the safe kill switch. No Claude/Codex global
configuration is changed by Sando. The production gate remains
`insufficient-evidence`; the current smoke is not evidence of a native Codex Tool
Search event or a production go decision.

The spike supports initialize, ping, tools/list, catalog discovery, and allowlisted
tools/call through `sando_call`. Other downstream request paths fail closed; auth,
approval, and elicitation are intentionally unsupported and are not propagated.

## Optional provider proxy

The plugin also includes the context/history transformer and an explicit proxy launcher for hosts that support a configured local base URL. The proxy is opt-in and leaves Codex transport untouched unless you point the client at its local URL:

```bash
SANDO_UPSTREAM_URL=https://api.example.test \
SANDO_PROXY_TRANSFORM=1 \
SANDO_CONTEXT_POLICY='{"maxHistoryTokens":1000}' \
/path/to/installed/sando/bin/sando-proxy
```

Point the provider client at the printed local URL. The proxy records request-level mechanical metrics; provider cost and turn comparisons still come from paired `apply`/`control` runs.

For the opt-in F1 footprint record, also set `SANDO_CONTEXT_FOOTPRINT_PATH`,
`SANDO_CONTEXT_FOOTPRINT_HOST` (`claude` or `codex`), and an explicit
`SANDO_CONTEXT_SESSION_KEY`. The record contains no request content; without a
session key the initial-context capture is skipped. Request transformation is
off by default and requires `SANDO_PROXY_TRANSFORM=1`. Individual historical
transform families can be disabled with `SANDO_CONTEXT_POLICY.strategies`.
For the local Grafana cockpit, set `SANDO_F1_TELEMETRY=1` and send to the
loopback-only `SANDO_F1_TELEMETRY_ENDPOINT=http://127.0.0.1:4319/v1/logs`;
only coverage and size buckets leave the capture process.

## Project redaction rules

Teams can add project-local detectors in `.sando/redaction.json`:

```json
{
  "schema": "sando-redaction/v1",
  "rules": [
    { "type": "assignment-key", "key": "DATABASE_URL" },
    { "type": "token-prefix", "prefix": "acme_", "minLength": 24, "maxLength": 128 }
  ]
}
```

Built-in detectors remain enabled. The supported declarative rules are `assignment-key` and `token-prefix`; both use the fixed `[REDACTED]` placeholder. The profile is loaded from the current project only, and its digest is recorded in receipts. Invalid profiles are reported instead of silently ignored.

## Telemetry

Telemetry is off by default. The plugin shows a non-blocking reminder until you make a choice. The optional npm library asks once during an interactive install. See the [full disclosure](TELEMETRY.md).
