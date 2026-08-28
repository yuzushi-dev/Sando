import fs from 'node:fs';
import path from 'node:path';

const VERSION_PATTERN = /^\d+\.\d+(?:\.\d+)?$/;
const STANDALONE_VERSION = '0.3.0';
const METADATA_FILES = ['package.json', '.claude-plugin/plugin.json', '.codex-plugin/plugin.json'];

function findMetadataFile() {
  let directory = path.resolve(import.meta.dirname, '..');
  while (true) {
    for (const relativePath of METADATA_FILES) {
      const file = path.join(directory, relativePath);
      if (fs.existsSync(file)) return file;
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return null;
}

const metadataPath = findMetadataFile();
const metadata = metadataPath ? JSON.parse(fs.readFileSync(metadataPath, 'utf8')) : { version: STANDALONE_VERSION };
if (typeof metadata.version !== 'string' || !VERSION_PATTERN.test(metadata.version)) {
  throw new Error(`Invalid Sando version in ${metadataPath}`);
}

// Evaluated once per process: no repeated filesystem reads in telemetry paths.
export const PLUGIN_VERSION = metadata.version;
