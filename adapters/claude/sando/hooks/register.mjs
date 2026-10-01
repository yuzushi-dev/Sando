// Thin UI mod (Claude Code >= 2.1.287): pins Sando's status line with $.ui.status.
// It never alters a tool result or any event; it only observes and displays.
// The text comes from the same statusline.mjs the settings statusLine uses, run as a
// child process so the metrics/provider-usage reading logic is not forked into the sandbox.
// The refresh is fire-and-forget: a slow or failing statusline.mjs never delays a tool result,
// a prompt or the end of a turn, and its errors are swallowed inside refresh().
// Older versions ignore this module and keep using statusline.mjs and the command hooks.

const MIN_INTERVAL_MS = 2000;

let lastRefresh = -1e15;
let sessionId;

async function refresh($, force) {
  try {
    const now = await $.clock.now();
    if (!force && now - lastRefresh < MIN_INTERVAL_MS) return;
    lastRefresh = now;
    const result = await $.process.run(['node', `${$.plugin.root}/statusline.mjs`], {
      stdin: JSON.stringify(sessionId ? { session_id: sessionId } : {}),
      timeoutMs: 2000,
    });
    const text = result.exitCode === 0 ? result.stdout.trim() : '';
    if (text) $.ui.status(text);
  } catch { /* display only: never affect the session */ }
}

export function register(on) {

  // session_id is only on the classic events' input, not on tool.call / turn.complete.
  on('classic.SessionStart', async ($, e, next) => {
    if (typeof e.session_id === 'string') sessionId = e.session_id;
    const r = await next(e);
    void refresh($, true);
    return r;
  });

  on('classic.PostToolUse', async ($, e, next) => {
    if (typeof e.session_id === 'string') sessionId = e.session_id;
    const r = await next(e);
    void refresh($, false);
    return r;
  });

  on('classic.Stop', async ($, e, next) => {
    if (typeof e.session_id === 'string') sessionId = e.session_id;
    const r = await next(e);
    void refresh($, true);
    return r;
  });
}
