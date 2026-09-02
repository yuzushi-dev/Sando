# Sando personal canary

The canary keeps the daily Claude/Codex MCP configuration unchanged. The
launchers generate their isolated MCP and hook configuration in private local
state and temporary files; machine-specific paths are not committed.

F4 is active only in these launchers. Both expose one local read-only gateway
downstream and exclude the original MCP list:

```bash
npm run canary:claude -- --print "Use sando_catalog, then stop."
node scripts/sando-canary-codex.mjs mcp list
```

For an actual Codex canary, run the launcher without `mcp list`. It uses the
existing ChatGPT login through a private local symlink; it does not copy the
credential. The normal Codex launcher is not changed.
The launcher uses Codex's default model unless `SANDO_CODEX_MODEL` is set.

The canary hooks collect provider and mechanical usage into the private
canary ledger. F1 remains capture/audit-only and F2 remains preview-only;
neither is silently promoted to an unverified automatic rewrite. Usage is
tagged `SANDO_EXPERIMENT=personal-canary` and `arm=apply` by default. Set
`SANDO_EXPERIMENT_ARM=control` for a control run and optionally set
`SANDO_EXPERIMENT_WORKLOAD` to a shared workload key.

Aggregate evidence, not prompts or transcripts:

```bash
npm run canary:report -- --experiment personal-canary --json
```

The report joins metrics by host/session where possible, hashes the local
ledger snapshots, and marks provider model/cost coverage as unavailable when
the source ledger does not contain it. Apply/control output is descriptive
until a shared paired-run key exists.

Rollback: stop the canary client. No global MCP entry is added or changed.
