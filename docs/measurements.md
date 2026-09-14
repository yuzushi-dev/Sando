# Measurements

Every number the README quotes, with the command that produces it and the conditions it holds
under. The figures come from two machines with different working habits, so where they disagree
you can see by how much.

## Shell output on Codex, 90.9%

CLI routing is on by default; `SANDO_CLI_ROUTING=0` switches it off, and with it off the hook
rewrites nothing.

```bash
node scripts/bench-codex-shell.mjs
```

This reads the recorded rollouts in `~/.codex/sessions`, runs each captured result through the
shipped optimiser, and reports what the bounded version would have cost.

| | tokens |
|---|---:|
| unbounded | 78.5M |
| bounded | 7.2M |
| reduction | 90.9% |

More than 40,000 results. The wrapper prepends a status envelope to every result, which makes
39% of them slightly larger. Those are the ones already under every cap, and they cost 0.4% of
the total against the 91% saved.

The surface is this rich because Codex runs everything through the shell: reads, searches,
builds. The median result is 1,981 bytes and 38.9% of them exceed the 4 KB cap. A handful of
giants does not carry the figure, since the ten largest results account for 3.6% of the bytes
and the largest 1% for 10.6%. The same measurement on a second, independent corpus gave 95.45%,
so it is not an artefact of one machine.

## Files into a context window, about 2.4x

```bash
node scripts/bench-reduction.mjs                    # this repository
node scripts/bench-reduction.mjs ~/code/your-repo   # any git checkout
```

The corpus is `git ls-files` at the checked-out commit, so anyone on that commit gets the same
number. Files below 1,024 bytes are excluded. The payload charged against the saving includes
the disclosure line, so the envelope never counts as a gain.

Measured on this repository at `release/0.5.0`:

| | files | token-weighted reduction | fires on | median file |
|---|---:|---:|---:|---:|
| this repository | 300 | 57.3% | 49.7% | 0.0% |

Reads before a 200,000-token window fills: 109 without, 261 with.

The counts move with the commit, since the corpus is the repository's own tracked files: adding
a few modules, or editing this page, shifts them slightly. The ratio is the stable part, between
2.39x and 2.44x across every commit measured so far, which is why the README quotes that
instead.

The spread matters more than the headline. The median file here reduces by nothing at all,
and four further checkouts gave reductions between 40% and 82% with the same median in two of
them, because the optimiser is selective and most single files sit under every cap. A repository also has
to be large enough to fill 200,000 tokens before the capacity figure means anything. On all
four of those checkouts the files ran out before the window did, which makes their ratios a
floor rather than a measurement.

## What survives truncation

From the part it cuts, middle elision keeps up to four test-runner totals (`# tests`, `# pass`,
`# fail`, `test result:`, `Tests:`), then error lines (`error`, `fail`, `exception`, `fatal`,
`panic`, `traceback`, `assertion`), then warnings. Eight lines at most, within half the
available budget.

This is what makes the `npm test` example in the README work. A runner that prints one summary
block per suite leaves the first block's totals in the middle of its own output. Without the
salvage a model reads the surviving block and reports it as the whole run: 100 tests where 573
had run, with nothing to mark the omission. Two machines and two models, `gpt-5.6-luna` and
`gemma4:31b-cloud`, both answered correctly in a single turn once the totals survived.

## Caps, by content class

| class | inline cap |
|---|---|
| source | 32 KB |
| structured data | 8 KB |
| logs and bulk | 4 KB |
| process output | 4 KB |

The artifact holding the full content is written with mode `0600` and its SHA-256 matches the
original. Recovery is bounded and can target a line range. An artifact is capped at 1 MiB by
default, and a wrapped command captures at most 16 MiB per stream; past those limits the input
is truncated at the source and the result says so.

Processing cost per call: 0.24 ms for a 5 KB source file, 0.95 ms for 22 KB, 10.3 ms for an
81 KB log.

## How the surfaces differ

On Claude the `PostToolUse` hook rewrites tool results in place, without touching how commands
execute, for every tool except the external `mcp__*` ones. On Codex the hook cannot rewrite output at all, and the only
channel left is rewriting the command before it runs. That is why Sando wraps shell commands
there and has no reason to on Claude.

The two surfaces also carry different weight. Measured across the results each one bounds:

| | machine A | machine B |
|---|---:|---:|
| Claude, tools the hook processes | 11.2M tokens, 14.5% ceiling | 4.5M tokens, 18.9% ceiling |
| Codex shell | 78.5M tokens, 91.9% ceiling | 28.1M tokens, 95.5% ceiling |

External `mcp__*` results are excluded from the Claude rows: the hook returns early on them
(`adapters/claude/sando/lib/hook-entry.mjs`), so they are never bounded. That exclusion costs
machine B 10.5 points, because its MCP traffic is large and highly compressible: counting it
would report a reduction the plugin does not deliver.

The gap that remains between the two Claude columns comes from which tools each person uses.
On machine A, `Read` is 64% of the tokens and reduces by 15.8%. `Read` itself lands within a
tenth of a point on both machines, 15.8% and 15.7%, because reading source files is reading
source files. `Bash` varies threefold, because what you run is a personal habit.

## What these numbers are not

They measure output reduction, one tool result at a time. What a session costs also depends on
prompt-cache economics, where a rewritten prefix is charged at 1.25x and a cache read at 0.10x,
and none of these measurements model that. Under controlled replay on a private transcript
corpus the median session came out roughly at break-even, with the gain concentrated in side
chains and long sessions.

## Provider accounting and paired controls

Sando records provider-reported input, cache-read, cache-write, output, reasoning, and turn
counts at session stop. It also records mechanical context trimming separately. A weighted token
estimate is diagnostic; provider cost and blended rates are shown only when the provider or host
reports them.

Run an explicit control session with the plugin still installed:

```bash
SANDO_EXPERIMENT=read-heavy \
SANDO_EXPERIMENT_ARM=control \
codex
```

Treatment sessions use `SANDO_EXPERIMENT_ARM=apply`, which is the default arm; the control arm
bypasses routing regardless of `SANDO_CLI_ROUTING`. Use the same experiment and optional `SANDO_EXPERIMENT_WORKLOAD` for
both arms. Generate the accounting report from the installed Codex plugin:

```bash
/path/to/installed/sando/bin/sando accounting --json
```

The paired report exposes control/treatment cache classes, output and reasoning tokens, model
turns, native/Sando tool calls, mechanical bytes, and weighted cost units. The separate
provider-usage report exposes reported USD cost with its coverage and source when available; a
host-reported list estimate is not a billing record. Replay results are marked counterfactual,
and mechanical reduction is never turned into a provider-billing claim.

The statusline shows mechanically estimated context tokens saved and its reduction percentage. A
leading `~` marks the estimate. Provider savings are not rendered as a percentage because their
denominator is not comparable to the mechanical estimate.

## Context footprint audit

The read-only audit measures an explicitly captured initial-context body for Claude Code or
Codex. It attributes observable bytes to host/project instructions, skills, built-in tools,
direct/deferred MCP, Sando, history, prompt, provider overhead, and `unknown`. It never uses
provider totals to invent a category breakdown. If the host body is not exposed, the result is
`unavailable`.

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

Capture files use `sando-context-capture/v1`. They contain byte counts or ephemeral content for
classified segments; reports retain only numeric totals and provenance digests, never paths,
prompts, or secrets. Mechanical token estimates (`ceil(UTF-8 bytes / 4)`) and provider-reported
usage are separate evidence classes.

## The cross-turn history experiment

A separate, opt-in surface archives older tool observations across turns, through the provider
proxy. It is an experiment, not a savings claim. Controlled provider-boundary replays reduced
reported input by 28.5% on Codex and effective input by 42.4% on Claude. Natural pilots ranged
much wider, from a 45.3% reduction to a 55.7% *increase*, so the mechanism is conditional on the
workload. That is why these figures stay out of the README's savings table.

## Does the Codex wrap preserve what it wraps?

CLI routing bounds shell output by rewriting the command before it runs, as
`sando exec -- bash -lc '<original>'`. That is a change to what executes, not just to what is
displayed, so turning it on by default needed evidence about behaviour rather than bytes.

```bash
node scripts/bench-wrap-divergence.mjs            # add --limit N for a short run
```

The harness runs each command twice, natively and wrapped, in two identical extractions of this
repository's tracked files, and compares the invariants a session depends on: exit code, death by
signal, the resulting working tree, and whether the command's output still reaches the caller
either inline or through the artifact. Output is *meant* to differ, so it is never compared for
equality.

### Corpus, n=1290

Distinct commands from 40,912 recorded Codex shell calls, filtered to those safe to execute (an
allowlist of read-only programs; 39,432 rejected).

| Invariant | Result |
|---|---:|
| exit code | 1290/1290 |
| death by signal | 1290/1290 |
| working tree identical | 1290/1290 |
| no unexpected mutation | 1290/1290 |
| stderr reaches the caller | 1290/1290 |
| output reachable | 1280/1290 |

The ten output cases are commands whose own output is non-deterministic: `node --test`, whose
`duration_ms` lines already differ by ten lines between two *native* runs, and one `sed` of a file
outside the fixture. Nothing was lost by the wrap in any of them.

### Probes

The safety filter that makes the corpus executable also excludes the shapes most likely to break,
so the corpus result alone would be misleading. These are tested directly:

| Probe | Native | Wrapped | |
|---|---|---|---|
| exit code 42 | 42 | 42 | preserved |
| death by SIGTERM | 143 | 143 | preserved |
| death by SIGKILL | 137 | 137 | preserved |
| standard input | piped input read | piped input read | preserved |
| stderr-only output | reaches | reaches | preserved |
| large output | 108,974 B | bounded, fully recoverable | preserved |
| binary output | 200 bytes | `[binary output withheld]` | withheld by design |

Two of these were defects, found by the probes and not by the corpus, and both are fixed:

- **Signal death collapsed to exit 1.** `runExec` set `process.exitCode = result.exitCode || 1`,
  and a child killed by a signal has a null exit code, so an OOM kill (137) and a timeout (143)
  both arrived as the same generic failure an ordinary command returns. It now reports
  `128 + signum`, as a shell does.
- **Standard input was dropped.** The capture spawned with `stdio: ['ignore', …]`, so a command
  reading stdin saw EOF. It is now inherited — except when stdin is a terminal, because the child
  runs detached in its own process group and a detached process reading a terminal is stopped with
  SIGTTIN. Under a hook or an agent, where this wrap runs, stdin is a pipe and is passed through.

Both are covered by regression tests in `tests/exec.test.mjs` in each Codex bundle, verified to
fail against the previous code. Binary output remains withheld rather than bounded; that is
deliberate and is visible in the result.
