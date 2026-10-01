import { test, expect, mock } from 'claude-code/testing'

const run = (stdout: string, exitCode = 0) => ({ exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })

function world(on: any, stdout: string, exitCode = 0) {
  const calls: { argv: readonly string[]; stdin?: string }[] = []
  const statuses: (string | undefined)[] = []
  mock.clock(on)
  on('classic.Stop', async () => ({ value: {} }))
  on('classic.PostToolUse', async () => ({ value: {} }))
  on('process.run', async (_$: any, e: any) => { calls.push({ argv: e.argv, stdin: e.init?.stdin }); return { value: run(stdout, exitCode) } })
  on('ui.status', async (_$: any, e: any) => { statuses.push(e.text); return { value: undefined } })
  return { calls, statuses }
}

const settle = async () => { for (let i = 0; i < 50; i++) await Promise.resolve() }

const post = { hook_event_name: 'PostToolUse', session_id: 's1', transcript_path: '', cwd: '/', tool_name: 'Bash', tool_input: {}, tool_response: {}, tool_use_id: 't' } as any

test('Stop pins the statusline.mjs text for the session', async ($, on) => {
  const w = world(on, '🥪 ~1.2k saved\n')
  await $.classic.Stop({ session_id: 's1' } as any)
  await settle()
  expect(w.statuses).toEqual(['🥪 ~1.2k saved'])
  expect(w.calls[0].argv[0]).toBe('node')
  expect(w.calls[0].argv[1].endsWith('/statusline.mjs')).toBe(true)
  expect(JSON.parse(w.calls[0].stdin as string)).toEqual({ session_id: 's1' })
})

test('a failing statusline.mjs leaves the status untouched', async ($, on) => {
  const w = world(on, '', 1)
  await $.classic.Stop({ session_id: 's1' } as any)
  await settle()
  expect(w.statuses).toEqual([])
})

test('PostToolUse refreshes without altering the chain result and is rate limited', async ($, on) => {
  const w = world(on, '🥪 —\n')
  await $.classic.PostToolUse(post)
  await $.classic.PostToolUse(post)
  await settle()
  expect(w.calls.length).toBe(1)
})

test('the hook chain does not wait for a slow refresh (fire-and-forget)', async ($, on) => {
  const statuses: (string | undefined)[] = []
  mock.clock(on)
  on('classic.Stop', async () => ({ value: {} }))
  on('classic.PostToolUse', async () => ({ value: {} }))
  on('process.run', () => new Promise(() => {}))
  on('ui.status', async (_$: any, e: any) => { statuses.push(e.text); return { value: undefined } })
  await $.classic.Stop({ session_id: 's1' } as any)
  await $.classic.PostToolUse(post)
  expect(statuses).toEqual([])
})
