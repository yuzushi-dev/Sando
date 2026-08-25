export function redact(text) {
  let count = 0;
  const replace = (pattern, replacement) => {
    text = text.replace(pattern, (...args) => {
      count += 1;
      return typeof replacement === 'function' ? replacement(...args) : replacement;
    });
  };
  replace(/-----BEGIN [A-Z ]+ KEY-----[\s\S]*?-----END [A-Z ]+ KEY-----/g, '[REDACTED PRIVATE KEY]');
  replace(/\b(?:sk|rk)-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED TOKEN]');
  replace(/\bgh[pousr]_[A-Za-z0-9_-]{12,}\b/g, '[REDACTED TOKEN]');
  replace(/\bgithub_pat_[A-Za-z0-9_-]{20,}\b/g, '[REDACTED TOKEN]');
  replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED TOKEN]');
  replace(/(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s,"'}]+/gi, (_match, prefix) => `${prefix}[REDACTED]`);
  replace(/(["']?(?:api[_-]?key|access[_-]?token|password|secret|private[_-]?key)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, (_match, prefix) => `${prefix}[REDACTED]`);
  return { text, count };
}

export function hasSecret(text) {
  return /(?:authorization|api[_-]?key|access[_-]?token|password|secret|private[_-]?key)\s*[:=]\s*(?!\[REDACTED\])\S+|-----BEGIN [A-Z ]+ KEY-----|\b(?:sk|rk)-[A-Za-z0-9_-]{12,}\b|\bgh[pousr]_[A-Za-z0-9_-]{12,}\b|\bgithub_pat_[A-Za-z0-9_-]{20,}\b|\bAKIA[0-9A-Z]{16}\b/i.test(text);
}
