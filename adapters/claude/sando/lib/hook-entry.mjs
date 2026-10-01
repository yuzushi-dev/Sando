// The Claude hook runs the canonical implementation (packages/sando/src/hook-cli.mjs, synced
// into this bundle as hook-cli.mjs). This file stays only so the hook entrypoint keeps its path;
// it must not grow logic of its own.
export { runHookCli, buildCodexFallback, isSandoMcpTool } from './hook-cli.mjs';
