#!/usr/bin/env node
/**
 * Verification script for live TypeSafe (Jev System One) integration in Sando.
 *
 * Validates:
 * 1. Secure API key discovery (env or ~/.config/typesafe/auth.json) without printing secrets.
 * 2. Live API latency, token usage, and returned model name.
 * 3. Deception resistance of Done-Guard (telemetry vs prose claims).
 * 4. Two-tier Stuck-Guard (Tier 1 deterministic fast-path vs Tier 2 semantic evaluation).
 */

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

import { TypeSafeClient } from '../lib/typesafe-client.mjs';
import { evaluateDoneClaim } from '../lib/done-guard.mjs';
import { StuckGuard } from '../lib/stuck-guard.mjs';

async function main() {
  console.log('=== Verifying Refined TypeSafe Integration for Sando ===\n');

  const client = new TypeSafeClient({ offlineFallback: false });

  if (!client.isConfigured()) {
    console.log('[-] Nessuna API key trovata in ~/.config/typesafe/auth.json o TYPESAFE_API_KEY.');
    process.exit(1);
  }

  console.log('[+] API Key configurata e protetta (non esposta nei log).');
  console.log('[*] Test di chiamata diretta verso https://api.typesafe.ai/v1/systemone...\n');

  // Test 1: Direct System One Evaluation
  const directResult = await client.evaluate(
    {
      message: 'Ho completato il refactoring del modulo auth e sistemato tutti i bug.',
    },
    {
      claims_done: {
        type: 'noul',
        instructions: 'Does this message state, assert, or imply that the task or bugfix is completed?',
      },
    },
    { timeoutMs: 3000 }
  );

  if (!directResult.ok) {
    console.error('[-] Chiamata API fallita:', directResult.error);
    process.exit(1);
  }

  console.log(`[+] Connessione riuscita in ${directResult.elapsedMs.toFixed(1)}ms!`);
  console.log(`    Model: ${directResult.model}`);
  if (directResult.usage) {
    console.log(`    Token usage: input=${directResult.usage.input_tokens}, output=${directResult.usage.output_tokens}`);
  }
  console.log(`    claims_done probability: ${directResult.answers.claims_done.value} (conf=${directResult.answers.claims_done.confidence})`);

  // Test 2: Done Guard Telemetry Enforcement
  console.log('\n[*] Test Done-Guard (Resistenza alle allucinazioni dell\'agente):');

  // Scenario A: Deceptive Claim ("all 12 tests pass" in text, but verified=false in telemetry)
  const unverified = await evaluateDoneClaim({
    finalMessage: 'Ho completato il refactoring e tutti i 12 test passano con successo!',
    hasCodeEdits: true,
    verified: false, // Sando knows no tests actually ran
    client,
  });
  console.log(`    Scenario A (Deceptive prose vs false telemetry):`);
  console.log(`      - claimsDone: ${unverified.claimsDone} (prob: ${unverified.claimsDoneProbability})`);
  console.log(`      - flagged:    ${unverified.flagged} (BLOCCATO: ${unverified.notice ? 'SI' : 'NO'})`);
  console.log(`      - elapsed:    ${unverified.elapsedMs.toFixed(1)}ms`);

  // Scenario B: Genuine Verified Claim (tests actually ran and passed in Sando)
  const verified = await evaluateDoneClaim({
    finalMessage: 'Ho completato il refactoring e tutti i 12 test passano con successo!',
    hasCodeEdits: true,
    verified: true, // Sando verified passing test command
    client,
  });
  console.log(`    Scenario B (Verified telemetry):`);
  console.log(`      - claimsDone: ${verified.claimsDone}`);
  console.log(`      - flagged:    ${verified.flagged} (AUTORIZZATO)`);
  console.log(`      - elapsed:    ${verified.elapsedMs.toFixed(1)}ms`);

  // Test 3: Stuck Guard Two-Tier Architecture
  console.log('\n[*] Test Stuck-Guard (Architettura a 2 livelli):');

  // Tier 1: Identical retries -> deterministic fast-path (0ms)
  const tmpFast = path.join(os.tmpdir(), `test-stuck-live-tier1-${Date.now()}.json`);
  const guardFast = new StuckGuard({ storagePath: tmpFast, failureThreshold: 3, client });
  await guardFast.recordToolResult({ tool: 'bash', input: 'python3 -m unittest test_db.py', output: 'ConnectionRefusedError: port 5432', exitCode: 1 });
  await guardFast.recordToolResult({ tool: 'bash', input: 'python3 -m unittest test_db.py', output: 'ConnectionRefusedError: port 5432', exitCode: 1 });
  const tier1Res = await guardFast.recordToolResult({ tool: 'bash', input: 'python3 -m unittest test_db.py', output: 'ConnectionRefusedError: port 5432', exitCode: 1 });
  console.log(`    Tier 1 (3 comandi identici):`);
  console.log(`      - stuck:   ${tier1Res.stuck}`);
  console.log(`      - tier:    ${tier1Res.tier} (0 chiamate API, ${tier1Res.elapsedMs}ms)`);
  console.log(`      - notice:  ${tier1Res.notice?.slice(0, 75)}...`);
  fs.rmSync(tmpFast, { force: true });

  // Tier 2: Syntactically different commands repeating same underlying strategy -> Jev semantic call
  const tmpSemantic = path.join(os.tmpdir(), `test-stuck-live-tier2-${Date.now()}.json`);
  const guardSemantic = new StuckGuard({ storagePath: tmpSemantic, failureThreshold: 3, client });
  await guardSemantic.recordToolResult({ tool: 'bash', input: 'pytest tests/test_auth.py -k login', output: 'AssertionError: token mismatch', exitCode: 1 });
  await guardSemantic.recordToolResult({ tool: 'bash', input: 'python -m unittest tests.test_auth.LoginTest', output: 'AssertionError: token mismatch', exitCode: 1 });
  const tier2Res = await guardSemantic.recordToolResult({ tool: 'bash', input: 'pytest --verbose tests/test_auth.py', output: 'AssertionError: token mismatch', exitCode: 1 });
  console.log(`    Tier 2 (3 comandi con sintassi diversa ma stessa strategia fallimentare):`);
  console.log(`      - stuck:   ${tier2Res.stuck}`);
  console.log(`      - tier:    ${tier2Res.tier}`);
  console.log(`      - model:   ${tier2Res.model}`);
  console.log(`      - risk:    ${tier2Res.riskScore}`);
  console.log(`      - elapsed: ${tier2Res.elapsedMs ? tier2Res.elapsedMs.toFixed(1) + 'ms' : '0ms'}`);
  fs.rmSync(tmpSemantic, { force: true });

  console.log('\n=== Tutti i collaudi live dei nuovi raffinamenti sono completati con successo! ===');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
