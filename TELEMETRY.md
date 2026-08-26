# Sando telemetry

Opt-in, off by default. Nothing is sent unless you run `telemetry-cli.mjs
enable` (see "Controlling it" below for the exact path) and answer `yes`
at the interactive prompt.

If you installed via the Claude Code marketplace
(`/plugin install sando@yuzushi`), a one-line reminder appears at the start
of each session until you've made a decision. The reminder only informs you.
It never blocks a session or prompts by itself.

## What's collected

Once a day, Sando buckets that day's counts and sends one row per event
type it saw:

- `hook`: tool-call count, redaction count, capped-output count, bytes
  saved, all bucketed (`zero`, `one`, `2_to_5`, `6_to_20`, `gt_20`; byte
  ranges like `16_to_64k`), per host (`claude`/`codex`) and mode
  (`enforce`/`observe`).
- `proxy`: rewrite-applied count, rewrite-skipped-for-cache count,
  estimated input tokens saved (bucketed), whether the prompt cache was
  hit that day.

## What's never collected

Transcript content, tool output, file paths, session IDs, turn IDs,
installation/device/account IDs, hostname, username, IP address, model
name, exception text, or any other free-form or identifying field. Values
are always bucketed, never a raw count or byte value.

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

**Installed via the Claude Code marketplace (`sando@yuzushi`):** the same
script lives at `lib/telemetry-cli.mjs` inside the installed plugin
  directory. Find it with `claude plugin list` or check what
`${CLAUDE_PLUGIN_ROOT}` resolves to for this plugin, then run
`node <that path>/lib/telemetry-cli.mjs enable`.

This is an opt-in sample, not a population measurement. Enabled users may
not represent everyone running Sando.
