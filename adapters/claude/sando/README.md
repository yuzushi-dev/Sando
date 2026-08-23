# Sando for Claude Code

Use this directory as a repo-local or copied/cache Claude Code plugin directory. Claude discovers `.claude-plugin/plugin.json`, `hooks/hooks.json`, and `.mcp.json`; `${CLAUDE_PLUGIN_ROOT}` resolves launchers whose runtime is bundled inside this directory.

`PostToolUse` supports replacement here. In `apply` mode the adapter emits
`hookSpecificOutput.updatedToolOutput` for string results and oversized
Bash-shaped `{stdout, stderr, ...}` results; other structured shapes remain
unchanged. Oversized payloads are written atomically as complete redacted mode
`0600` files under
`cwd/.sando/sando/artifacts` and the replacement contains that relative
reference. `observe` and `dry-run` return `{}`. The hook is fail-open for
malformed events, persistence, and telemetry errors; only invalid
`SANDO_POLICY` is fail-closed with exit `2`.

```sh
claude --plugin-dir "$REPO/adapters/claude/sando"
node --test packages/sando/tests/*.test.mjs
```

No Claude configuration or marketplace is changed.

The hook also persists numeric savings records in the default local state file
or the absolute `SANDO_METRICS_PATH` override. Run
`node adapters/claude/sando/metrics.mjs` for a human report or add
`--json` for the `sando-report/v1` shape used by a later status bar.
