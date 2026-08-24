export const ROUTING_POLICY_VERSION = 'sando-routing/v1';

const READ_SUMMARY_LIMITS = Object.freeze({
  minTotalLines: 100,
  maxSummaryBytes: 2 * 1024 * 1024,
  maxSummaryLines: 20_000,
});
const GREP_LIMITS = Object.freeze({
  files: 20,
  matchesPerFile: 20,
  singleFileMatches: 200,
  internalTotalMatches: 2_000,
  nativeMaxFileBytes: 4 * 1024 * 1024,
  timeoutMs: 30_000,
  maxColumns: 512,
});
const OUTPUT_LIMITS = Object.freeze({
  spillBytes: 50 * 1024,
  headBytes: 20 * 1024,
  tailBytes: 20 * 1024,
  tailLines: 500,
  maxColumns: 768,
});

const isNonNegativeSafeInteger = (value) => Number.isSafeInteger(value) && value >= 0;

export function planToolRoute({
  toolName,
  selector = false,
  raw = false,
  lineCount = 0,
  fileBytes,
  prose = false,
  summarizeProse = false,
  summarizeEnabled = true,
  grepScope = 'multi',
  outputBytes = 0,
} = {}) {
  const name = typeof toolName === 'string' ? toolName.toLowerCase() : toolName;
  const readCanSummarize = name === 'read'
    && !selector
    && !raw
    && summarizeEnabled
    && (!prose || summarizeProse)
    && isNonNegativeSafeInteger(lineCount)
    && lineCount >= READ_SUMMARY_LIMITS.minTotalLines
    && lineCount <= READ_SUMMARY_LIMITS.maxSummaryLines
    && isNonNegativeSafeInteger(fileBytes)
    && fileBytes > 0
    && fileBytes <= READ_SUMMARY_LIMITS.maxSummaryBytes;

  if (readCanSummarize) {
    return {
      route: 'summary',
      modelVisible: 'elided-structure',
      source: 'sando-read-summarize',
      limits: READ_SUMMARY_LIMITS,
    };
  }

  if (name === 'grep') {
    return {
      route: 'structured',
      modelVisible: 'bounded-matches',
      source: 'sando-grep',
      limits: Object.freeze({
        ...GREP_LIMITS,
        matchesPerFile: grepScope === 'single-file'
          ? GREP_LIMITS.singleFileMatches
          : GREP_LIMITS.matchesPerFile,
      }),
    };
  }

  if (name === 'bash' && isNonNegativeSafeInteger(outputBytes) && outputBytes > OUTPUT_LIMITS.spillBytes) {
    return {
      route: 'artifact',
      modelVisible: 'head-tail-artifact-ref',
      source: 'sando-output-meta',
      limits: OUTPUT_LIMITS,
    };
  }

  return {
    route: 'passthrough',
    modelVisible: 'bounded-output',
    source: 'spike-default',
  };
}
