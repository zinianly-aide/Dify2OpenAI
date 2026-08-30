function finiteValues(values) {
  return values.map(Number).filter(Number.isFinite);
}

function sum(values) { return finiteValues(values).reduce((total, value) => total + value, 0); }
function avg(values) {
  const xs = finiteValues(values);
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}
function rate(count, total) { return total ? count / total : 0; }
function percentile(values, p) {
  const xs = finiteValues(values).sort((a, b) => a - b);
  if (!xs.length) return null;
  const rank = Math.max(0, Math.min(xs.length - 1, Math.ceil(p * xs.length) - 1));
  return xs[rank];
}
function keyFor(event, dimensions) {
  return dimensions.map((dimension) => `${dimension}=${String(event[dimension] ?? 'unknown')}`).join('|');
}

export const OFFLINE_ANALYZER_VERSION = 'offline-policy-analyzer-v1';
export const DEFAULT_ANALYSIS_DIMENSIONS = Object.freeze(['clientType', 'taskType', 'backendId', 'model', 'policyVersion']);

export class OfflinePolicyAnalyzer {
  constructor({ analyzerVersion = OFFLINE_ANALYZER_VERSION } = {}) {
    this.analyzerVersion = analyzerVersion;
  }

  summarize(events = []) {
    const requestCount = events.length;
    const successCount = events.filter((event) => event.success === true).length;
    const errorCount = requestCount - successCount;
    const compressionCount = events.filter((event) => String(event.compressionMode || 'none') !== 'none').length;
    const checkpointCount = events.filter((event) => event.checkpointCreated === true).length;
    const rotationCount = events.filter((event) => event.rotationOccurred === true).length;
    const pruningCount = events.filter((event) => Number(event.toolCountAfter) < Number(event.toolCountBefore)).length;
    const recoveryCount = events.filter((event) => event.toolRecoveryTriggered === true).length;
    const fallbackCount = events.filter((event) => event.fallbackUsed === true).length;
    const overflowCount = events.filter((event) => {
      if (Number.isFinite(Number(event.backendPromptTokens)) && Number.isFinite(Number(event.contextWindow)) && Number(event.contextWindow) > 0) {
        return Number(event.backendPromptTokens) > Number(event.contextWindow);
      }
      return String(event.errorType || '').toUpperCase().includes('CONTEXT_LIMIT');
    }).length;
    const toolSuccessValues = events.map((event) => event.toolSuccessRate).filter((value) => Number.isFinite(Number(value)));
    const latency = events.map((event) => event.latencyMs);
    const firstToken = events.map((event) => event.firstTokenLatencyMs);
    const highContextCount = events.filter((event) => Number(event.contextUtilization) >= 0.8).length;
    return Object.freeze({
      requestCount,
      successRate: rate(successCount, requestCount),
      errorRate: rate(errorCount, requestCount),
      promptTokens: Object.freeze({
        estimated: sum(events.map((event) => event.estimatedInputTokens)),
        compressed: sum(events.map((event) => event.compressedTokens)),
        observedBackend: sum(events.map((event) => event.backendPromptTokens)),
      }),
      completionTokens: sum(events.map((event) => event.completionTokens)),
      toolSchemaTokens: Object.freeze({
        before: sum(events.map((event) => event.toolSchemaTokensBefore)),
        after: sum(events.map((event) => event.toolSchemaTokensAfter)),
        saved: sum(events.map((event) => event.toolSchemaTokensSaved)),
      }),
      tokenSavings: sum(events.map((event) => Math.max(0, Number(event.estimatedInputTokens || 0) - Number(event.compressedTokens || event.estimatedInputTokens || 0)))),
      compressionFrequency: rate(compressionCount, requestCount),
      checkpointFrequency: rate(checkpointCount, requestCount),
      rotationFrequency: rate(rotationCount, requestCount),
      contextAmplification: Object.freeze({ avg: avg(events.map((event) => event.contextAmplification)), p95: percentile(events.map((event) => event.contextAmplification), 0.95) }),
      contextOverflow: Object.freeze({ count: overflowCount, rate: rate(overflowCount, requestCount) }),
      highContextRate: rate(highContextCount, requestCount),
      toolPruningRate: rate(pruningCount, requestCount),
      toolRecoveryRate: rate(recoveryCount, requestCount),
      toolSuccessRate: toolSuccessValues.length ? avg(toolSuccessValues) : null,
      fallbackRate: rate(fallbackCount, requestCount),
      latencyMs: Object.freeze({ p50: percentile(latency, 0.50), p95: percentile(latency, 0.95), p99: percentile(latency, 0.99) }),
      firstTokenLatencyMs: Object.freeze({ p50: percentile(firstToken, 0.50), p95: percentile(firstToken, 0.95), p99: percentile(firstToken, 0.99) }),
      estimatedCost: sum(events.map((event) => event.estimatedCost)),
    });
  }

  analyze(snapshotOrEvents, { dimensions = DEFAULT_ANALYSIS_DIMENSIONS } = {}) {
    const events = Array.isArray(snapshotOrEvents) ? snapshotOrEvents : snapshotOrEvents?.events || [];
    const groups = new Map();
    for (const event of events) {
      const key = keyFor(event, dimensions);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(event);
    }
    const grouped = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, groupEvents]) => Object.freeze({
      key,
      dimensions: Object.freeze(Object.fromEntries(dimensions.map((dimension) => [dimension, groupEvents[0]?.[dimension] ?? null]))),
      metrics: this.summarize(groupEvents),
    }));
    return Object.freeze({
      analyzerVersion: this.analyzerVersion,
      requestCount: events.length,
      dimensions: Object.freeze([...dimensions]),
      overall: this.summarize(events),
      groups: Object.freeze(grouped),
    });
  }
}
