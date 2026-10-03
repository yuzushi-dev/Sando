# Sando native Codex benchmark result

Status: **complete; operational regression gate failed**.

Subsequent [failure analysis](failure-analysis.md) found nine outcomes ambiguous
under overly literal citation checks and reproduced a substantive redaction
display-contract defect in a targeted Sando probe. The frozen score is unchanged;
it must not be interpreted as a causal difference in semantic quality.

The frozen `sando-v1` ledger records all 100 scheduled attempts: 10 synthetic tasks, five repetitions per arm, and counterbalanced order. Ninety-six provider/client runs completed and four were interrupted before verification. Control completed 47/50 tasks (94%); Sando completed 38/50 (76%), a difference of -18 percentage points. This fails both predeclared quality conditions: Sando had nine fewer successful completions overall, and four tasks had two fewer Sando successes.

These are strict machine-checked task outcomes. They do not establish statistical equivalence or a general difference in human-perceived answer quality. Four Sando runs were interrupted by the outer terminal wrapper rather than the model; they remain failed, unverified attempts in the frozen denominator. Even without treating those four as verified task failures, `locate-log-failure` and `redact-secrets` independently fail the per-task gate.

## Frozen environment

| Field | Value |
|---|---|
| Manifest | `sando-v1`, SHA-256 `2fb5ae5ccda5433b4674dcadb8e19d7d983602b73e6873a4bbd1f73fac900eb0` |
| Executed source tree | SHA-256 `5bf1c3058f3fae5eb89a72c2cdbcb23b23ff803df1e6008ac6e98c8aff6b21b5` |
| Executed runner | SHA-256 `c02d6a92d41f329187d9c57e00ddeea51cefe7986e31dbf129cbf6282d2e6e96` |
| Event ledger | SHA-256 `aa91be7fcf2c1226b95c0caad2795788fef5e24d68bf446769108c19925e85dc` |
| Repository commit | `0e523fdf754c7667d3593ced26a82dbdebf8113a` |
| Codex | 0.159.2; launcher SHA-256 `61b0194f3bb6534439c8d26a3ed57d0805f84b884588b761795323eeb92fcf70` |
| Native binary | SHA-256 `1748767b230ebfc3d4ab7e4e254920d0c0ad9691fd8c11f190e7d44511a4a92e` |
| Model | `gpt-6.1-sol`, low reasoning effort |
| Runtime | ChatGPT subscription, ephemeral isolated configuration, `workspace-write`, approval policy `never` |
| Pair concurrency | 2; order preserved within each pair |

All 46 completed Sando runs recorded trusted hook output and consumption of rewritten commands. All 50 control runs recorded no Sando hook activity. The four interrupted Sando runs have no model, usage, duration, or tool-call evidence and are marked `successVerified: false`.

## Task completion

| Task | Control | Sando | Difference |
|---|---:|---:|---:|
| locate-log-failure | 3/5 | 1/5 | -2 |
| repair-csv-parser | 5/5 | 5/5 | 0 |
| redact-secrets | 5/5 | 3/5 | -2 |
| aggregate-events | 5/5 | 5/5 | 0 |
| preserve-argv | 5/5 | 3/5 | -2 |
| deduplicate-usage | 5/5 | 5/5 | 0 |
| recover-artifact-evidence | 4/5 | 3/5 | -1 |
| trace-config-precedence | 5/5 | 5/5 | 0 |
| reconcile-documentation | 5/5 | 5/5 | 0 |
| fix-window-calculation | 5/5 | 3/5 | -2 |
| **Total** | **47/50** | **38/50** | **-9** |

The four infrastructure interruptions were Sando runs for `preserve-argv` repetitions 3 and 4 and `fix-window-calculation` repetitions 4 and 5. Two separate 15-minute outer terminal limits caused them. The resumable ledger retained each as `interrupted-before-completion`; none was rerun or removed.

## Observed usage

The complete paired subset excludes the four pairs whose Sando run was interrupted, leaving 46 observations per arm:

| Metric | Control | Sando | Sando change |
|---|---:|---:|---:|
| Successful completions | 43/46 | 38/46 | -5 |
| Input tokens | 2,685,953 | 2,800,936 | +4.28% |
| Cache-read tokens | 2,438,912 | 2,540,416 | +4.16% |
| Output tokens | 22,580 | 23,377 | +3.53% |
| Duration | 1,661,046 ms | 1,726,419 ms | +3.94% |
| Tool calls | 164 | 175 | +6.71% |

Across every observed run, control reported 2,926,316 input, 2,656,768 cache-read, and 24,266 output tokens over 50 runs. Sando reported 2,800,936 input, 2,540,416 cache-read, and 23,377 output tokens over 46 runs. Those unequal totals are descriptive and must not be compared as a full-cohort reduction.

No Sando artifact retrieval occurred; the synthetic outputs stayed below the artifact threshold. The frozen collector used the wrong native alias for cache-write tokens, so cache-write totals are unavailable even though cache-read counters are valid. The post-run runner fixes that alias for future benchmark IDs; the archived runner preserves the exact executed source. No omitted counter was backfilled.

## Cost and publication gate

The run used ChatGPT subscription authentication. It has no API invoice and lacked the request-level billing metadata required by the pricing profile. API cost, supported monetary subtotal, and cost per successful completion are therefore `null`/`indeterminate`, never zero. The cost publication gate is closed because monetary data is unavailable and the quality gate failed.

The immutable evidence is stored in `packages/sando/benchmarks/results/sando-v1-events.jsonl`; the compact machine-readable aggregate is `sando-v1-summary.jsonl`, and `sando-v1-runner-source.txt` is the exact runner used. `sando-v1-accounting-source.txt` preserves the accounting module included in the executed source-tree fingerprint (SHA-256 `f3bcb868ae101510a54dc6b530a2a1f7d2eaec6c7839bcf571fbfe86163e0dc4`); it was not active in the model hook path. An earlier API-key preflight made zero provider requests and was superseded by the user's explicit authorization for native subscription execution.
