// Compatibility aliases for older direct imports. Routing no longer reads this module.
export {
  DEFAULT_ACCOUNTING_WEIGHTS as DEFAULT_ADAPTIVE_WEIGHTS,
  PAIRED_ARMS as ADAPTIVE_ARMS,
  computeWeightedUsage as computeUsageCost,
  pairedArmFromEnv as adaptiveArmFromEnv,
  pairedExperimentFromEnv as adaptiveExperimentFromEnv,
  pairedWorkloadFromEnv as adaptiveWorkloadFromEnv,
  summarizePairedSessions as summarizeAdaptiveSessions,
} from './paired-accounting.mjs';
