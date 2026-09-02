# Sando telemetry

Telemetry starts disabled. Sando sends data only after you explicitly answer the
consent prompt with `y`, `yes`, `n`, or `no`, or use one of the controls below.
Input is case-insensitive. An empty or unrecognized answer leaves telemetry off
without recording a decline.

If you installed via the Claude Code marketplace
(`/plugin install sando@yuzushi`), a one-line reminder appears at the start
of the first session. It records that it was shown before displaying the
reminder, so it is shown only once. The reminder only informs you. It never
blocks a session or prompts by itself.

The Codex marketplace plugin shows the same one-line reminder at `SessionStart`.

The local consent state is explicit: `unasked`, `asked`, `enabled`, or
`declined`. A decline is final for the first-use reminder. The state and any
queued data stay on the local machine.

If `DO_NOT_TRACK` is set to any non-empty value other than `0`, it is a
runtime privacy override: Sando does not prompt, collect, queue, or upload
telemetry, even when the local config says `enabled: true`. Sando does not
rewrite that config; unset `DO_NOT_TRACK` to use the saved setting again.

## What's collected

Once a day, Sando buckets that day's counts and sends only these event shapes:

- `hook_summary`: host (`claude`/`codex`), mode (`enforce`, `observe`,
  `dry_run`), tool-call count, capped-output count, mechanical byte-reduction
  bucket, and estimated input-token reduction bucket.
- `proxy_summary`: provider (`anthropic`, `openai`, `unknown`), mode
  (`enforce`), rewrite-applied count, rewrite-skipped-for-cache count, and
  estimated input-token reduction bucket.
- `active_day`: one marker per UTC day and hook host.
- `hook_failure_summary` and `proxy_failure_summary`: one row per UTC day,
  host/provider, and closed failure stage. Stages are `policy`, `input`,
  `redaction`, `optimization`, `artifact`, `output`, `upstream`, and
  `response`.

All counts and byte values use fixed buckets (`zero`, `one`, `2_to_5`,
`6_to_20`, `21_to_100`, `gt_100`; byte ranges such as `16_to_64k`). Redaction counts and
local cache observations may remain in local diagnostics, but are not sent.

Sando never sends partial counters for the current day; daily aggregates are sent
only after that UTC day closes. The marker is flushed asynchronously.

New queue rows use schema v2. During the rollout, already queued v1 aggregate
rows are accepted and sent unchanged until drained; the collector must accept
both versions. Unsupported queue schemas are rejected before they are persisted.

## What's never collected

Transcript content, tool output, file paths, session IDs, turn IDs,
installation/device/account IDs, hostname, username, IP address, model
name, exception text, raw failure messages, or any other free-form or
identifying field. Sando sends bucket labels, not raw counts or byte values.

The wire schema keeps the historical `bytes_saved_bucket` and
`input_tokens_saved_bucket` field names. These fields describe mechanical
reduction; they do not measure provider billing.

## Where it goes

The endpoint is `https://telemetry.yuzushi.party/v1/logs`. Data is sent over
HTTPS to a shared backend: an OpenTelemetry Collector receives the validated
JSON rows, Loki stores them, and Grafana is used for inspection. Sando rows
use a closed schema separate from other projects. The collector receives only
the application payload described here: Sando does not put transcript text,
tool output, or identifiers into telemetry rows.

Server retention is 13 months for aggregate rows only. The local upload queue
is bounded to approximately 30 days of daily rows (up to 4096 rows / 4 MiB);
older unsent rows are evicted first during an outage.

The endpoint is live. An independent privacy review remains open.

## Controlling it

When the SessionStart reminder is visible, reply with one exact full message:

```text
sando telemetry yes
sando telemetry no
```

These commands are matched literally; natural-language variants and partial
matches are ignored. `yes` enables collection and `no` declines or revokes it.

The package does not install a global `sando` command. Run
`telemetry-cli.mjs` directly. Only the script path changes by installation type:

For a Git checkout:

```sh
node packages/sando/src/telemetry-cli.mjs status
node packages/sando/src/telemetry-cli.mjs enable    # interactive only, asks y/yes/n/no
node packages/sando/src/telemetry-cli.mjs preview   # shows the exact next upload body, sends nothing
node packages/sando/src/telemetry-cli.mjs flush
node packages/sando/src/telemetry-cli.mjs disable --purge
```

For an npm install:

```sh
node node_modules/sandoichi/src/telemetry-cli.mjs status
node node_modules/sandoichi/src/telemetry-cli.mjs enable
node node_modules/sandoichi/src/telemetry-cli.mjs preview
node node_modules/sandoichi/src/telemetry-cli.mjs flush
node node_modules/sandoichi/src/telemetry-cli.mjs disable --purge
```

To disable telemetry persistently, run `disable` (optionally with `--purge` to
remove queued local data), or reply `sando telemetry no` when the hook is
installed. To disable it for a process or environment without changing the
saved consent, set `DO_NOT_TRACK=1` (or any non-empty value other than `0`).

For the Claude Code marketplace plugin (`sando@yuzushi`), the same script lives
at `lib/telemetry-cli.mjs` inside the installed plugin directory. Find it with
`claude plugin list` or check what
`${CLAUDE_PLUGIN_ROOT}` resolves to for this plugin, then run
`node <that path>/lib/telemetry-cli.mjs enable`.

For the Codex marketplace, run the script from the installed plugin root:
`node <plugin-root>/lib/telemetry-cli.mjs status`.

This is an opt-in sample, not a population measurement. Enabled users may
not represent everyone running Sando.
