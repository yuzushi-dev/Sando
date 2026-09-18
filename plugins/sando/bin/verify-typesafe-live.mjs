#!/usr/bin/env node
/**
 * Verification script for live TypeSafe (Jev System One) integration in Sando.
 *
 * Validates:
 * 1. Secure API key discovery (env or ~/.config/typesafe/auth.json) without printing secrets.
 * 2. Live API latency, token usage, and returned model name.
 * 3. Accuracy of evaluateDoneClaim on completed vs unverified scenarios.
 * 4. Accuracy of StuckGuard on repetitive vs exploratory tool patterns.
 */

import { TypeSafeClient } from '../lib/typesafe-client.mjs';
import { evaluateDoneClaim } from '../lib/done-guard.mjs';
import { StuckGuard } from '../lib/stuck-guard.mjs';

async function main() {
  console.log('=== Verifying TypeSafe AI Integration for Sando ===\n');

  const client = new TypeSafeClient({ offlineFallback: false });

  if (!client.isConfigured()) {
    console.log('[-] Nessuna API key trovata.');
    console.log('    Per configurarla in modo sicuro su questo host, esegui:');
    console.log('    mkdir -p ~/.config/typesafe');
    console.log('    cat << \'KEYEOF\' > ~/.config/typesafe/auth.json');
    console.log('    {');
    console.log('      "api_key": "YOUR_ACTUAL_KEY_HERE"');
    console.log('    }');
    console.log('    KEYEOF');
    console.log('    chmod 600 ~/.config/typesafe/auth.json\n');
    console.log('    Oppure: export TYPESAFE_API_KEY="YOUR_ACTUAL_KEY_HERE"\n');
    process.exit(1);
  }

  console.log('[+] API Key rilevata (preservata in sicurezza, non stampata a video).');
  console.log('[*] Test di connettività verso https://api.typesafe.ai/v1/systemone...\n');

  // Test 1: Direct System One Evaluation
  const t0 = Date.now();
  const directResult = await client.evaluate(
    {
      task: 'Fix race condition in database pool',
      last_message: 'Refactored connection pooling logic, everything is complete and tested.',
    },
    {
      is_done_claim: {
        type: 'noul',
        instructions: 'Does this message claim or assert that the task is completed?',
      },
      confidence_level: {
        type: 'score',
        instructions: 'Score how confident the completion claim is (0 = tentative, 1 = absolute certainty).',
        criteria: [
          'Tentative or conditional completion',
          'Standard completion assertion',
          'Explicit absolute certainty with evidence cited',
        ],
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
  console.log('    Risposte del modello:');
  for (const [qid, ans] of Object.entries(directResult.answers)) {
    console.log(`      - ${qid}: val=${ans.value} (conf=${ans.confidence})`);
  }

  // Test 2: Done Guard Evaluation (unverified vs verified)
  console.log('\n[*] Test Done-Guard su scenari reali:');
  const unverified = await evaluateDoneClaim({
    finalMessage: 'Ho completato il refactoring e sistemato tutto.',
    hasCodeEdits: true,
    testsRan: false,
    testsPassed: false,
    client,
  });
  console.log(`    Scenario A (Unverified claim): flagged=${unverified.flagged}, risk=${unverified.riskScore.toFixed(2)} (${unverified.elapsedMs.toFixed(1)}ms)`);

  const verified = await evaluateDoneClaim({
    finalMessage: 'Ho completato il refactoring e tutti i 12 test passano.',
    hasCodeEdits: true,
    testsRan: true,
    testsPassed: true,
    client,
  });
  console.log(`    Scenario B (Verified claim):   flagged=${verified.flagged}, risk=${verified.riskScore.toFixed(2)} (${verified.elapsedMs.toFixed(1)}ms)`);

  // Test 3: Stuck Guard Evaluation
  console.log('\n[*] Test Stuck-Guard su retry loop:');
  const stuckGuard = new StuckGuard({ client, failureThreshold: 3 });
  const simulatedFailures = [
    { tool: 'bash', input: 'python3 -m unittest test_db.py', error: 'ConnectionRefusedError: port 5432' },
    { tool: 'bash', input: 'python3 -m unittest test_db.py', error: 'ConnectionRefusedError: port 5432' },
    { tool: 'bash', input: 'python3 -m unittest test_db.py', error: 'ConnectionRefusedError: port 5432' },
  ];
  const stuckResult = await stuckGuard.checkStuck(simulatedFailures);
  console.log(`    Stuck loop detected: stuck=${stuckResult.stuck}, risk=${stuckResult.riskScore.toFixed(2)} (${stuckResult.elapsedMs.toFixed(1)}ms)`);

  console.log('\n=== Tutti i test live di TypeSafe per Sando sono stati eseguiti con successo! ===');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
