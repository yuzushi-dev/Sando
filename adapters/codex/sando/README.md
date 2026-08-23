# Sando Codex adapter

Standalone companion layout for exercising Codex hook and MCP launchers directly or from a copied/cache directory. The installable Codex manifest lives at `plugins/sando/.codex-plugin/plugin.json`; this adapter carries its own runtime and has no runtime import from `packages/`.

The default `PostToolUse` command is observational and returns `{}`. With `SANDO_POLICY={"mode":"apply"}` and `SANDO_CODEX_FALLBACK=feedback`, it returns `continue:false` feedback; this stops the turn and does not transparently replace the already-delivered tool result. Effective preparation uses MCP tool `prepare_tool_output`. Malformed host events fail open; invalid `SANDO_POLICY` exits `2`. No user config, marketplace, or installed Codex files are changed.

```sh
printf '%s' '{"hook_event_name":"PostToolUse","tool_name":"Read","tool_response":"ok","cwd":"/tmp"}' | node adapters/codex/sando/hooks/post-tool-use.mjs
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | node adapters/codex/sando/mcp/server.mjs
```

PostToolUse metrics are persisted in the default local state file or the
absolute `SANDO_METRICS_PATH` override. Run
`node adapters/codex/sando/metrics.mjs` for a human report or add
`--json` for the `sando-report/v1` shape. Codex remains observational for
transparent rewriting; its metrics do not claim provider savings unless paired
provider counters are supplied.
