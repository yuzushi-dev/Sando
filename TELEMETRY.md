# Sando telemetry

Opt-in, off by default. Nothing is sent unless you run `telemetry-cli.mjs
enable` (see "Controlling it" below for the exact path) and answer `yes`
at the interactive prompt.

If you installed via the Claude Code marketplace
(`/plugin install sando@yuzushi`), a one-line reminder appears at the start
of each session until you've made a decision. The reminder only informs you.
It never blocks a session or prompts by itself.

If `DO_NOT_TRACK` is set to any non-empty value other than `0`, it is a
runtime privacy override: Sando does not prompt, collect, queue, or upload
telemetry, even when the local config says `enabled: true`. Sando does not
rewrite that config; unset `DO_NOT_TRACK` to use the saved setting again.

## What's collected

Once a day, Sando buckets that day's counts and sends only these event shapes:

- `hook_summary`: host (`claude`/`codex`), mode (`enforce`, `observe`,
  `dry_run`), tool-call count, capped-output count, bytes saved, and estimated
  input tokens saved.
- `proxy_summary`: provider (`anthropic`, `openai`, `unknown`), mode
  (`enforce`), rewrite-applied count, rewrite-skipped-for-cache count, and
  estimated input tokens saved.
- `active_day`: one marker per UTC day and hook host.
- `hook_failure_summary` and `proxy_failure_summary`: one row per UTC day,
  host/provider, and closed failure stage. Stages are `policy`, `input`,
  `redaction`, `optimization`, `artifact`, `output`, `upstream`, and
  `response`.

All counts and byte values use fixed buckets (`zero`, `one`, `2_to_5`,
`6_to_20`, `gt_20`; byte ranges such as `16_to_64k`). Redaction counts and
local cache observations may remain in local diagnostics, but are not sent.

It never sends partial counters for the current day; daily aggregates are sent
only after that UTC day closes. The marker is flushed asynchronously.

## What's never collected

Transcript content, tool output, file paths, session IDs, turn IDs,
installation/device/account IDs, hostname, username, IP address, model
name, exception text, raw failure messages, or any other free-form or
identifying field. Values are always bucketed, never a raw count or byte value.

## Where it goes

The endpoint is `https://telemetry.yuzushi.party/v1/logs`. It uses a shared
backend (OpenTelemetry Collector → Loki → Grafana) also used by the
`session-handoff` project. Each project has its own closed schema. See
`~/selfhosted/telemetry/docs/telemetry-privacy.md` (separate infra repo,
shared with session-handoff) for the full data inventory,
retention, and processor list, and
`~/selfhosted/telemetry/docs/telemetry-canary-report.md` for the current
release status. As of writing, the canary and independent privacy review
remain open. The endpoint is live before those gates close. That is an
explicit choice, not evidence that the gates are complete.

Retention: 13 months, aggregate rows only.

The local upload queue is bounded to approximately 30 days of daily rows (up to
4096 rows / 4 MiB); older unsent rows are evicted first during an outage.

## Controlling it

There's no global `sando` command yet. Run `telemetry-cli.mjs` directly.
The commands are the same either way, only the path to the script changes:

**From a git checkout, or the `sandoichi` npm package:**

```sh
node packages/sando/src/telemetry-cli.mjs status
node packages/sando/src/telemetry-cli.mjs enable    # interactive only, asks yes/no
node packages/sando/src/telemetry-cli.mjs preview   # shows the exact next upload body, sends nothing
node packages/sando/src/telemetry-cli.mjs flush
node packages/sando/src/telemetry-cli.mjs disable --purge
```

To disable telemetry persistently, run `disable` (optionally with `--purge` to
remove queued local data). To disable it for a process or environment without
changing the saved consent, set `DO_NOT_TRACK=1` (or any non-empty value other
than `0`).

**Installed via the Claude Code marketplace (`sando@yuzushi`):** the same
script lives at `lib/telemetry-cli.mjs` inside the installed plugin
  directory. Find it with `claude plugin list` or check what
`${CLAUDE_PLUGIN_ROOT}` resolves to for this plugin, then run
`node <that path>/lib/telemetry-cli.mjs enable`.

This is an opt-in sample, not a population measurement. Enabled users may
not represent everyone running Sando.
