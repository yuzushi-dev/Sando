# Sando telemetry

Opt-in, off by default. Nothing is sent unless you run `sando telemetry
enable` and answer `yes` at the interactive prompt.

## What's collected

Once a day, Sando buckets that day's counts and sends one row per event
type it saw:

- **hook**: tool-call count, redaction count, capped-output count, bytes
  saved — bucketed (`zero`, `one`, `2_to_5`, `6_to_20`, `gt_20`; byte
  ranges like `16_to_64k`), per host (`claude`/`codex`) and mode
  (`enforce`/`observe`).
- **proxy**: rewrite-applied count, rewrite-skipped-for-cache count,
  estimated input tokens saved (bucketed), whether the prompt cache was
  hit that day.

## What's never collected

Transcript content, tool output, file paths, session IDs, turn IDs,
installation/device/account IDs, hostname, username, IP address, model
name, exception text, or any other free-form or identifying field. Values
are always bucketed — never a raw count or byte value.

## Where it goes

`https://telemetry.yuzushi.party/v1/logs` — a shared backend (OpenTelemetry
Collector → Loki → Grafana) also used by the `session-handoff` project,
each with its own closed schema. See
`~/selfhosted/telemetry/docs/telemetry-privacy.md` (separate infra repo,
shared with session-handoff) for the full data inventory,
retention, and processor list, and
`~/selfhosted/telemetry/docs/telemetry-canary-report.md` for the current
release status (as of writing: canary and independent privacy review
still open — the endpoint below is live ahead of those gates, an explicit
choice, not a signal they're done).

Retention: 13 months, aggregate rows only.

## Controlling it

```sh
sando telemetry status
sando telemetry enable    # interactive only, asks yes/no
sando telemetry preview   # shows the exact next upload body, sends nothing
sando telemetry flush
sando telemetry disable --purge
```

This is an opt-in sample, not a population measurement — enabled users may
not be representative of everyone running Sando.
