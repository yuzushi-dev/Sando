import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const allowed = /^(LICENSE|README\.md|index\.mjs|package\.json|src\/[a-z0-9-]+\.mjs|pricing\/[a-z0-9.-]+\.json)$/;
const forbidden = /(?:canary|instruction-plan|f2[-_])/i;

export function validateNpmPack(pack) {
  if (!Array.isArray(pack) || pack.length !== 1 || pack[0]?.name !== 'sandoichi' || !Array.isArray(pack[0]?.files)) {
    throw new Error('Unexpected npm pack result: expected one sandoichi package');
  }

  const paths = pack[0].files.map((file) => file?.path);
  const invalid = paths.filter((path) => (
    typeof path !== 'string' || !allowed.test(path) || forbidden.test(path)
  ));
  if (invalid.length > 0) {
    throw new Error(`Unexpected npm package files: ${invalid.join(', ')}`);
  }

  return paths.length;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const count = validateNpmPack(JSON.parse(readFileSync(0, 'utf8')));
  console.log(`Validated sandoichi npm archive (${count} files)`);
}
