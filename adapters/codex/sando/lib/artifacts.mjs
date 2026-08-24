import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export function persistArtifact(cwd, artifact) {
  const root = fs.realpathSync(cwd);
  if (!fs.statSync(root).isDirectory()) throw new Error('artifact cwd is not a directory');
  const directory = path.join(root, '.sando', 'sando', 'artifacts');
  for (const target of [path.join(root, '.sando'), path.join(root, '.sando', 'sando'), directory]) {
    const stat = fs.lstatSync(target, { throwIfNoEntry: false });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error('artifact directory is unsafe');
    if (!stat) fs.mkdirSync(target, { mode: 0o700 });
  }
  const name = `${artifact.sourceDigest.slice('sha256:'.length)}.txt`;
  const destination = path.join(directory, name);
  const temporary = path.join(directory, `.${name}.${process.pid}.${randomUUID()}`);
  try {
    fs.writeFileSync(temporary, artifact.content, { flag: 'wx', mode: 0o600 });
    try { fs.linkSync(temporary, destination); }
    catch (error) {
      if (error?.code !== 'EEXIST' || fs.readFileSync(destination, 'utf8') !== artifact.content) throw error;
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  fs.chmodSync(destination, 0o600);
  return path.posix.join('.sando/sando', 'artifacts', name);
}

export function materializeArtifact(result, cwd) {
  if (!result.artifact) return result.inline;
  return result.inline.replace(result.artifact.ref, persistArtifact(cwd, result.artifact));
}
