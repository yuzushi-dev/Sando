import { recoverArtifactContent } from './artifact-recovery.mjs';

const MAX_ARTIFACTS = 128;
const MAX_STORED_BYTES = 64 * 1024 * 1024;
const store = new Map();
let storedBytes = 0;

export function rememberArtifact(artifact) {
  if (!artifact || typeof artifact.ref !== 'string' || typeof artifact.content !== 'string') throw new TypeError('artifact is invalid');
  const bytes = Buffer.byteLength(artifact.content);
  if (bytes > MAX_STORED_BYTES) throw new RangeError('artifact exceeds in-process recovery limit');
  const previous = store.get(artifact.ref);
  if (previous) storedBytes -= previous.bytes;
  store.delete(artifact.ref);
  while (store.size >= MAX_ARTIFACTS || storedBytes + bytes > MAX_STORED_BYTES) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    storedBytes -= store.get(oldest).bytes;
    store.delete(oldest);
  }
  store.set(artifact.ref, {
    content: artifact.content,
    digest: artifact.sourceDigest,
    sourceBytes: artifact.sourceBytes ?? artifact.bytes,
    bytes,
  });
  storedBytes += bytes;
}

export function recoverStoredArtifact(options = {}) {
  const entry = store.get(options.ref);
  if (!entry) throw new Error('artifact handle is unavailable in this MCP session');
  store.delete(options.ref);
  store.set(options.ref, entry);
  return recoverArtifactContent({ ...options, ...entry });
}

export function exposeMcpResult(result) {
  if (!result?.artifact) return result;
  rememberArtifact(result.artifact);
  const { content: _content, ...artifact } = result.artifact;
  return { ...result, artifact };
}
