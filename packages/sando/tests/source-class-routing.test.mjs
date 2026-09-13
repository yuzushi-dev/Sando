import assert from 'node:assert/strict';
import test from 'node:test';

import { optimizeToolOutput } from '../src/core.mjs';

// Gate G1: Un outline strutturale non deve MAI subire [middle elided] (Banda B).
// Se l'outline supera il budget, o si aumenta il budget della rotta source o si emette un outline compatto,
// ma non devono mai comparire contemporaneamente i marker 'middle-elision' e 'structure-preview'.
test('G1: structural outline is never middle-elided', () => {
  // Generiamo un file JS di ~350 righe con molte dichiarazioni di funzioni, in modo che l'outline superi 4 KB
  const lines = ['import fs from \'node:fs\';'];
  for (let i = 1; i <= 150; i++) {
    lines.push(`export function func_${i}() {`);
    lines.push(`  const x = ${i};`);
    lines.push(`  return x * 2;`);
    lines.push('}');
  }
  const output = lines.join('\n'); // ~600 righe, ~14 KB, con 150 funzioni esportate
  const result = optimizeToolOutput({
    toolName: 'Read',
    output,
    cwd: '/work',
    lineCount: lines.length,
    fileBytes: Buffer.byteLength(output),
    prose: false,
  });

  const markers = result.disclosure?.markers ?? [];
  const hasMiddleElision = markers.includes('middle-elision') || result.inline.includes('[middle elided]');
  const hasStructure = markers.includes('structure-preview') || result.inline.includes('[sando read structure:');

  // Non devono mai coesistere: se c'è l'outline, non deve essere tagliato nel mezzo
  assert.ok(!(hasMiddleElision && hasStructure), 'outline must never have middle-elision');
});

// Gate G2: Copertura multi-linguaggio accurata per Python, Go e Rust (Banda C).
// Se il file contiene funzioni/dichiarazioni in Python ('def'), non deve emettere un outline ingannevole
// che tralascia le funzioni (es. solo 1-2 import su 50 funzioni).
test('G2: multi-language outline accuracy for Python and Go', () => {
  // File Python con 30 funzioni def e 1 import
  const pyLines = ['import os'];
  for (let i = 1; i <= 30; i++) {
    pyLines.push(`def handler_${i}(request, response):`);
    pyLines.push(`    # process request ${i}`);
    pyLines.push(`    return {"status": "ok", "id": ${i}}`);
    pyLines.push('');
  }
  const pyOutput = pyLines.join('\n'); // ~120 righe
  const pyResult = optimizeToolOutput({
    toolName: 'Read',
    output: pyOutput,
    cwd: '/work',
    toolInput: { file_path: 'service.py' },
    lineCount: pyLines.length,
    fileBytes: Buffer.byteLength(pyOutput),
    prose: false,
  });

  if (pyResult.disclosure?.markers?.includes('structure-preview')) {
    // Se ha emesso un outline, deve contenere le funzioni def!
    assert.match(pyResult.inline, /def handler_1\b/, 'Python outline must capture def declarations');
    assert.match(pyResult.inline, /def handler_20\b/, 'Python outline must capture def declarations across the file');
  } else {
    // Se non ha emesso outline, deve preservare il file integro (entro budget source) o non un fake outline
    assert.doesNotMatch(pyResult.inline, /\[sando read structure: [1-5]\//, 'must not emit a fake outline with missing defs');
  }
});

// Gate G3: Letture mirate (con selettore esplicito come offset/limit o sed -n) entro il budget source (32 KB) non vengono mai elise.
test('G3: targeted read with selector within source budget is never middle-elided', () => {
  // Lettura mirata di 200 righe di codice (~8 KB, > 4 KB default ma ben entro il budget source di 32 KB)
  const lines = [];
  for (let i = 100; i < 300; i++) {
    lines.push(`const variable_${i} = computeValue(${i}, "some extra padding data for realism");`);
  }
  const output = lines.join('\n'); // 200 righe, ~16 KB
  assert.ok(Buffer.byteLength(output) > 4096, 'fixture must be > 4096 bytes to test the bug');
  assert.ok(Buffer.byteLength(output) < 32768, 'fixture must be < 32 KB (within source budget)');

  // Caso A: Read con selector esplicito (offset / limit)
  const readResult = optimizeToolOutput({
    toolName: 'Read',
    output,
    cwd: '/work',
    toolInput: { file_path: 'module.ts', offset: 100, limit: 200 },
    selector: true,
    lineCount: lines.length,
    fileBytes: Buffer.byteLength(output),
    prose: false,
  });

  assert.doesNotMatch(readResult.inline, /\[middle elided\]/, 'targeted Read with selector must not be middle-elided');
  assert.equal(readResult.inline, output, 'targeted Read should be returned in full without truncation');

  // Caso B: Bash con comando sed mirato o cat di file sorgente entro budget
  const bashResult = optimizeToolOutput({
    toolName: 'Bash',
    output,
    cwd: '/work',
    toolInput: { command: "sed -n '100,299p' src/module.ts" },
    prose: false,
  });

  assert.doesNotMatch(bashResult.inline, /\[middle elided\]/, 'targeted Bash sed must not be middle-elided');
  assert.equal(bashResult.inline, output, 'targeted Bash sed should be returned in full');
});

// Test C5: Disclosure del range eliso esatto e recovery mirato quando scatta la middle elision
test('C5: disclosure includes elidedRange and targeted recovery command when middle elision occurs', () => {
  const lines = Array.from({ length: 500 }, (_, index) => `log line ${index}: some process output with data ${index * 10}`);
  const output = lines.join('\n'); // 500 righe di log di processo (~30 KB > 4 KB process budget)
  const result = optimizeToolOutput({
    toolName: 'Bash',
    output,
    cwd: '/work',
    toolInput: { command: 'npm test' },
    prose: false,
  });

  assert.ok(result.inline.includes('[middle elided]'), 'should middle-elide voluminous process output');
  assert.ok(result.artifact, 'should produce an artifact');
  const disclosure = result.disclosure;
  assert.ok(disclosure.artifact.elidedRange, 'disclosure should include elidedRange');
  assert.ok(Number.isInteger(disclosure.artifact.elidedRange.startLine), 'startLine should be an integer');
  assert.ok(Number.isInteger(disclosure.artifact.elidedRange.endLine), 'endLine should be an integer');
  assert.ok(disclosure.artifact.elidedRange.startLine > 1, 'startLine should be after head');
  assert.ok(disclosure.artifact.elidedRange.endLine < lines.length, 'endLine should be before tail');
  assert.match(
    disclosure.artifact.recovery.command,
    /--start-line \d+ --end-line \d+/,
    'recovery command should offer targeted start-line and end-line retrieval'
  );
});

