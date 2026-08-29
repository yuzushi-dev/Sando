export const MAX_EXEC_CAPTURE_BYTES = 16_777_216;

function terminate(child, signal) {
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {}
  try { child.kill(signal); } catch {}
}

function incompleteUtf8Suffix(buffer) {
  let index = buffer.length - 1;
  let continuation = 0;
  while (index >= 0 && (buffer[index] & 0xc0) === 0x80) {
    continuation += 1;
    index -= 1;
  }
  if (index < 0) return 0;
  const lead = buffer[index];
  const expected = lead >= 0xc2 && lead <= 0xdf ? 2
    : lead >= 0xe0 && lead <= 0xef ? 3
      : lead >= 0xf0 && lead <= 0xf4 ? 4 : 0;
  return expected > continuation + 1 ? continuation + 1 : 0;
}

export function textOrBinary(buffer, { truncated = false } = {}) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('output must be a Buffer');
  if (buffer.includes(0)) return { binary: true, text: '', utf8Truncated: false };
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try { return { binary: false, text: decoder.decode(buffer), utf8Truncated: false }; }
  catch {
    if (!truncated) return { binary: true, text: '', utf8Truncated: false };
    const suffix = incompleteUtf8Suffix(buffer);
    if (!suffix) return { binary: true, text: '', utf8Truncated: false };
    try {
      return { binary: false, text: decoder.decode(buffer.subarray(0, -suffix)), utf8Truncated: true };
    } catch {
      return { binary: true, text: '', utf8Truncated: false };
    }
  }
}

export function captureProcess(child, { maxBytes, timeoutMs, signal } = {}) {
  if (!child || typeof child.once !== 'function' || !Number.isSafeInteger(maxBytes) || maxBytes < 1
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('capture options are invalid');
  return new Promise((resolve, reject) => {
    const buffers = { stdout: [], stderr: [] };
    const captured = { stdout: 0, stderr: 0 };
    const truncated = { stdout: false, stderr: false };
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let forceTimer;
    let timer;
    const collect = (name, chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = Math.max(0, maxBytes - captured[name]);
      if (remaining) {
        const part = buffer.subarray(0, remaining);
        buffers[name].push(part);
        captured[name] += part.length;
      }
      if (buffer.length > remaining) truncated[name] = true;
    };
    const stop = (signalName) => {
      terminate(child, signalName);
      if (signalName === 'SIGTERM' && forceTimer === undefined) {
        forceTimer = setTimeout(() => terminate(child, 'SIGKILL'), 250);
      }
    };
    const finish = (result, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceTimer);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve({
        stdout: Buffer.concat(buffers.stdout), stderr: Buffer.concat(buffers.stderr),
        stdoutBytes: captured.stdout, stderrBytes: captured.stderr,
        stdoutTruncated: truncated.stdout, stderrTruncated: truncated.stderr,
        truncated: truncated.stdout || truncated.stderr, timedOut, cancelled, ...result,
      });
    };
    const onAbort = () => { cancelled = true; stop('SIGTERM'); };
    timer = setTimeout(() => { timedOut = true; stop('SIGTERM'); }, timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (chunk) => collect('stdout', chunk));
    child.stderr?.on('data', (chunk) => collect('stderr', chunk));
    child.once('error', (error) => finish(null, error));
    child.once('close', (exitCode, exitSignal) => finish({ exitCode, exitSignal }));
    if (signal?.aborted) onAbort();
  });
}
