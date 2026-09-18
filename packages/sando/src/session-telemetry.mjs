/**
 * Session Verification Telemetry for Sando Guards.
 *
 * Tracks empirical truth across tool executions in a session:
 * - Code edits invalidate previous test verifications (testsPassedAfterLastEdit = false).
 * - Passing test runs establish genuine verification (testsPassedAfterLastEdit = true).
 * - Persisted securely in /tmp/sando-<uid>/ with strict ownership validation.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour

const EDIT_TOOLS = new Set([
  'write_to_file', 'replace_file_content', 'edit_file',
  'write', 'edit', 'str_replace_editor', 'create_file',
]);

const TEST_COMMAND_PATTERNS = [
  /\b(?:npm\s+test|npm\s+run\s+test|pytest|vitest|jest|cargo\s+test|go\s+test|python[0-9.]*\s+-m\s+unittest)\b/i,
  /\b(?:node\s+--test|make\s+test|ctest|bun\s+test|deno\s+test)\b/i,
];

const EDIT_COMMAND_PATTERNS = [
  /\b(?:git\s+apply|patch|sed\s+-i|tee|touch)\b/i,
  />\s*[^&|]/, // Output redirection to file
];

function getTelemetryDir() {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'shared';
  const stateDir = path.join(os.tmpdir(), `sando-${uid}`);
  try {
    if (fs.existsSync(stateDir)) {
      const stat = fs.lstatSync(stateDir);
      if (stat.isSymbolicLink() || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
        const home = process.env.HOME || os.tmpdir();
        const safeDir = path.join(home, '.cache', 'sando', `telemetry-${uid}`);
        fs.mkdirSync(safeDir, { recursive: true, mode: 0o700 });
        return safeDir;
      }
    } else {
      fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    }
  } catch {
    const fallbackDir = path.join(os.tmpdir(), `sando-${uid}-${process.pid}`);
    try {
      fs.mkdirSync(fallbackDir, { recursive: true, mode: 0o700 });
      return fallbackDir;
    } catch {}
  }
  return stateDir;
}

function resolveSessionPath(sessionId) {
  const safeId = String(sessionId || 'default').replaceAll(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(getTelemetryDir(), `session-telemetry-${safeId}.json`);
}

export function loadSessionTelemetry(sessionId) {
  const filePath = resolveSessionPath(sessionId);
  try {
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (data && typeof data === 'object') {
        const now = Date.now();
        if (typeof data.updatedAt === 'number' && (now - data.updatedAt) < SESSION_TTL_MS) {
          return {
            hasCodeEdits: Boolean(data.hasCodeEdits),
            testsPassedAfterLastEdit: Boolean(data.testsPassedAfterLastEdit),
            updatedAt: data.updatedAt,
          };
        }
      }
    }
  } catch {}
  return { hasCodeEdits: false, testsPassedAfterLastEdit: false, updatedAt: Date.now() };
}

export function saveSessionTelemetry(sessionId, telemetry) {
  const filePath = resolveSessionPath(sessionId);
  try {
    const dir = path.dirname(filePath);
    const tmpPath = path.join(dir, `.tmp-${path.basename(filePath)}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const payload = {
      hasCodeEdits: Boolean(telemetry.hasCodeEdits),
      testsPassedAfterLastEdit: Boolean(telemetry.testsPassedAfterLastEdit),
      updatedAt: Date.now(),
    };
    fs.writeFileSync(tmpPath, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmpPath, filePath);
  } catch {}
}

export function recordToolEvent({ sessionId, toolName, toolInput, exitCode }) {
  const normalizedTool = (toolName || '').toLowerCase();
  const inputStr = typeof toolInput === 'string' ? toolInput : JSON.stringify(toolInput || {});

  const isEditTool = EDIT_TOOLS.has(normalizedTool);
  const isEditCommand = EDIT_COMMAND_PATTERNS.some((p) => p.test(inputStr));
  const isCodeEdit = isEditTool || isEditCommand;

  const isTestCommand = TEST_COMMAND_PATTERNS.some((p) => p.test(inputStr));
  const isPassingTest = isTestCommand && exitCode === 0;

  if (!isCodeEdit && !isTestCommand) return;

  const telemetry = loadSessionTelemetry(sessionId);

  if (isCodeEdit) {
    telemetry.hasCodeEdits = true;
    telemetry.testsPassedAfterLastEdit = false; // INVALIDE PREVIOUS VERIFICATION
  } else if (isPassingTest) {
    telemetry.testsPassedAfterLastEdit = true;
  }

  saveSessionTelemetry(sessionId, telemetry);
}
