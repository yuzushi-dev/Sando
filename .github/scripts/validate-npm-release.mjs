import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const stableTag = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function validateNpmRelease(tag, packageVersion) {
  const match = stableTag.exec(tag);
  if (!match) throw new Error(`Refusing to publish: ${tag} is not a stable vX.Y.Z tag`);

  const tagVersion = tag.slice(1);
  if (packageVersion !== tagVersion) {
    throw new Error(`Refusing to publish: tag ${tag} does not match package version ${packageVersion}`);
  }

  return tagVersion;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [tag, packagePath] = process.argv.slice(2);
  if (!tag || !packagePath) throw new Error('Usage: validate-npm-release.mjs <tag> <package.json>');

  const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
  const version = validateNpmRelease(tag, packageJson.version);
  console.log(`Validated sandoichi ${version}`);
}
