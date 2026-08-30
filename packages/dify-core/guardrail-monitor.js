import { canonicalJson, sha256 } from './canonical.js';
import { PolicyStatus } from './policy-registry.js';

export const GuardrailStatus = Object.freeze({
  ELIGIBLE_FOR_PROMOTION: 'ELIGIBLE_FOR_PROMOTION',
  INSUFFICIENT_CANARY_EVIDENCE: 'INSUFFICIENT_CANARY_EVIDENCE',
  HOLD_FOR_REVIEW: 'HOLD_FOR_REVIEW',
  AUTO_ROLLBACK: 'AUTO_ROLLBACK',
  EVALUATION_FAILED: 'EVALUATION_FAILED',
});

export const DEFAULT_CANARY_GUARDRAIL_CONFIG = Object.freeze({
  stages: Object.freeze({
    [PolicyStatus.CANARY_5]: Object.freeze({ minimumRequests: 50, minimumObservationWindowMs: 15 * 60 * 1000 }),
    [PolicyStatus.CANARY_20]: Object.freeze({ minimumRequests: 200, minimumObservationWindowMs: 30 * 60 * 1000 }),
    [PolicyStatus.CANARY_50]: Object.freeze({ minimumRequests: 500, minimumObservationWindowMs: 60 * 60 * 1000 }),
  }),
  maxErrorRateAbsolute: 0.20,
  maxErrorRateHardDelta: 0.05,
  maxOverflowRateHardDelta: 0.05,
  maxToolSuccessHardDrop: 0.05,
  maxToolRecoveryRateHard: 0.08,
  maxFallbackRateHardDelta: 0.08,
  maxErrorRateSoftDelta: 0.01,
  maxOverflowRateSoftDelta: 0.01,
  maxToolSuccessSoftDrop: 0.01,
  maxToolRecoveryRateSoft: 0.04,
  maxFallbackRateSoftDelta: 0.02,
  maxLatencyP95IncreasePct: 20,
  maxFirstTokenP95IncreasePct: 20,
  maxRoutingDriftRateForPromotion: 0.20,
  minimumTokenOrCostImprovementPct: 1,
});

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function bool(value) { return value === true; }
function iso(value) {
  const text = String(value || '');
  if (!text || Number.isNaN(Date.parse(text))) throw new Error('GUARDRAIL_TIMESTAMP_INVALID');
  return new Date(text).toISOString();
}
function q(values, percentile) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(percentile * sorted.length) - 1);
  return sorted[index];
}
function rate(n, d) { return d ? n / d : 0; }
function pctDelta(candidate, baseline) {
  if (!baseline) return candidate === baseline ? 0 : null;
  return ((candidate - baseline) / baseline) * 100;
}
function sum(values) { return values.reduce((total, value) => total + (number(value) ?? 0), 0); }

function sanitizeOutcome(input = {}) {
  return Object.freeze({
    timestamp: iso(input.timestamp),
    policyVersion: String(input.policyVersion || ''),
    success: bool(input.success),
    backendPromptTokens: number(input.backendPromptTokens),
    completionTokens: number(input.completionTokens),
    estimatedCost: number(input.estimatedCost),
    contextOverflow: bool(input.contextOverflow) || (number(input.contextWindow) !== null && number(input.backendPromptTokens) !== null && number(input.backendPromptTokens) > number(input.contextWindow)),
    forcedCompression: bool(input.forcedCompression) || String(input.compressionMode || '').toLowerCase() === 'force',
    checkpointCreated: bool(input.checkpointCreated),
    toolRequest: bool(input.toolRequest) || number(input.toolCountBefore) > 0,
    toolSuccess: input.toolSuccess === undefined ? null : bool(input.toolSuccess),
    toolSuccessRate: number(input.toolSuccessRate),
    toolRecoveryTriggered: bool(input.toolRecoveryTriggered),
    fallbackUsed: bool(input.fallbackUsed),
    latencyMs: number(input.latencyMs),
    firstTokenLatencyMs: number(input.firstTokenLatencyMs),
    capabilityViolationCount: Math.max(0, number(input.capabilityViolationCount) ?? 0),
    unsupportedDecisionCount: Math.max(0, number(input.unsupportedDecisionCount) ?? 0),
    policyValidationFailure: bool(input.policyValidationFailure),
    routingDrift: bool(input.routingDrift),
  });
}

function metrics(events) {
  const requestCount = events.length;
  const successful = events.filter((event) => event.success).length;
  const toolEvents = events.filter((event) => event.toolRequest || event.toolSuccessRate !== null || event.toolSuccess !== null);
  const toolRates = toolEvents.map((event) => event.toolSuccessRate ?? (event.toolSuccess === true ? 1 : event.toolSuccess === false ? 0 : null)).filter((value) => value !== null);
  const latency = events.map((event) => event.latencyMs).filter((value) => value !== null);
  const firstToken = events.map((event) => event.firstTokenLatencyMs).filter((value) => value !== null);
  return Object.freeze({
    requestCount,
    successRate: rate(successful, requestCount),
    errorRate: rate(requestCount - successful, requestCount),
    backendPromptTokens: sum(events.map((event) => event.backendPromptTokens)),
    completionTokens: sum(events.map((event) => event.completionTokens)),
    estimatedCost: sum(events.map((event) => event.estimatedCost)),
    contextOverflowRate: rate(events.filter((event) => event.contextOverflow).length, requestCount),
    forcedCompressionRate: rate(events.filter((event) => event.forcedCompression).length, requestCount),
    checkpointRate: rate(events.filter((event) => event.checkpointCreated).length, requestCount),
    toolSuccessRate: toolRates.length ? toolRates.reduce((a, b) => a + b, 0) / toolRates.length : 1,
    toolRecoveryRate: rate(events.filter((event) => event.toolRecoveryTriggered).length, Math.max(toolEvents.length, requestCount)),
    fallbackRate: rate(events.filter((event) => event.fallbackUsed).length, requestCount),
    latencyMs: Object.freeze({ p50: q(latency, 0.50), p95: q(latency, 0.95), p99: q(latency, 0.99) }),
    firstTokenLatencyMs: Object.freeze({ p50: q(firstToken, 0.50), p95: q(firstToken, 0.95), p99: q(firstToken, 0.99) }),
    capabilityViolationCount: sum(events.map((event) => event.capabilityViolationCount)),
    unsupportedDecisionCount: sum(events.map((event) => event.unsupportedDecisionCount)),
    policyValidationFailureCount: events.filter((event) => event.policyValidationFailure).length,
    routingDriftRate: rate(events.filter((event) => event.routingDrift).length, requestCount),
  });
}

export class GuardrailMonitor {
  constructor(config = {}) {
    this.config = Object.freeze({
      ...DEFAULT_CANARY_GUARDRAIL_CONFIG,
      ...config,
      stages: Object.freeze({ ...DEFAULT_CANARY_GUARDRAIL_CONFIG.stages, ...(config.stages || {}) }),
    });
    this.events = [];
  }

  record(input) {
    const event = sanitizeOutcome(input);
    if (!event.policyVersion) throw new Error('POLICY_VERSION_REQUIRED');
    this.events.push(event);
    return event;
  }

  list(policyVersion, { startTime, endTime } = {}) {
    const start = startTime ? iso(startTime) : null;
    const end = endTime ? iso(endTime) : null;
    return this.events.filter((event) => event.policyVersion === policyVersion && (!start || event.timestamp >= start) && (!end || event.timestamp <= end));
  }

  evaluate({ policyVersion, baselinePolicyVersion, stage, observationStart, observationEnd } = {}) {
    const start = iso(observationStart);
    const end = iso(observationEnd);
    const stageConfig = this.config.stages[stage];
    if (!stageConfig) throw new Error('CANARY_STAGE_INVALID');
    const candidateEvents = this.list(policyVersion, { startTime: start, endTime: end });
    const baselineEvents = this.list(baselinePolicyVersion, { startTime: start, endTime: end });
    const candidateMetrics = metrics(candidateEvents);
    const baselineMetrics = metrics(baselineEvents);
    const elapsedMs = new Date(end).getTime() - new Date(start).getTime();
    const reasonCodes = [];
    let status;

    if (candidateMetrics.requestCount < stageConfig.minimumRequests || elapsedMs < stageConfig.minimumObservationWindowMs || baselineMetrics.requestCount === 0) {
      status = GuardrailStatus.INSUFFICIENT_CANARY_EVIDENCE;
      reasonCodes.push('INSUFFICIENT_CANARY_EVIDENCE');
    } else {
      if (candidateMetrics.capabilityViolationCount > 0) reasonCodes.push('CAPABILITY_VIOLATION');
      if (candidateMetrics.policyValidationFailureCount > 0) reasonCodes.push('POLICY_VALIDATION_FAILURE');
      if (candidateMetrics.unsupportedDecisionCount > 0) reasonCodes.push('UNSUPPORTED_DECISION');
      if (candidateMetrics.errorRate > this.config.maxErrorRateAbsolute || candidateMetrics.errorRate - baselineMetrics.errorRate > this.config.maxErrorRateHardDelta) reasonCodes.push('ERROR_RATE_HARD_REGRESSION');
      if (candidateMetrics.contextOverflowRate - baselineMetrics.contextOverflowRate > this.config.maxOverflowRateHardDelta) reasonCodes.push('CONTEXT_OVERFLOW_HARD_REGRESSION');
      if (baselineMetrics.toolSuccessRate - candidateMetrics.toolSuccessRate > this.config.maxToolSuccessHardDrop) reasonCodes.push('TOOL_SUCCESS_HARD_REGRESSION');
      if (candidateMetrics.toolRecoveryRate > this.config.maxToolRecoveryRateHard) reasonCodes.push('TOOL_RECOVERY_HARD_REGRESSION');
      if (candidateMetrics.fallbackRate - baselineMetrics.fallbackRate > this.config.maxFallbackRateHardDelta) reasonCodes.push('FALLBACK_HARD_REGRESSION');

      if (reasonCodes.length) {
        status = GuardrailStatus.AUTO_ROLLBACK;
      } else {
        const soft = [];
        if (candidateMetrics.errorRate - baselineMetrics.errorRate > this.config.maxErrorRateSoftDelta) soft.push('ERROR_RATE_SOFT_REGRESSION');
        if (candidateMetrics.contextOverflowRate - baselineMetrics.contextOverflowRate > this.config.maxOverflowRateSoftDelta) soft.push('CONTEXT_OVERFLOW_SOFT_REGRESSION');
        if (baselineMetrics.toolSuccessRate - candidateMetrics.toolSuccessRate > this.config.maxToolSuccessSoftDrop) soft.push('TOOL_SUCCESS_SOFT_REGRESSION');
        if (candidateMetrics.toolRecoveryRate > this.config.maxToolRecoveryRateSoft) soft.push('TOOL_RECOVERY_SOFT_REGRESSION');
        if (candidateMetrics.fallbackRate - baselineMetrics.fallbackRate > this.config.maxFallbackRateSoftDelta) soft.push('FALLBACK_SOFT_REGRESSION');
        const latencyPct = pctDelta(candidateMetrics.latencyMs.p95 ?? 0, baselineMetrics.latencyMs.p95 ?? 0);
        const firstTokenPct = pctDelta(candidateMetrics.firstTokenLatencyMs.p95 ?? 0, baselineMetrics.firstTokenLatencyMs.p95 ?? 0);
        if (latencyPct !== null && latencyPct > this.config.maxLatencyP95IncreasePct) soft.push('LATENCY_P95_SOFT_REGRESSION');
        if (firstTokenPct !== null && firstTokenPct > this.config.maxFirstTokenP95IncreasePct) soft.push('FIRST_TOKEN_P95_SOFT_REGRESSION');
        if (candidateMetrics.routingDriftRate > this.config.maxRoutingDriftRateForPromotion) soft.push('ROUTING_DRIFT_REVIEW');
        const tokenPct = pctDelta(candidateMetrics.backendPromptTokens, baselineMetrics.backendPromptTokens);
        const costPct = pctDelta(candidateMetrics.estimatedCost, baselineMetrics.estimatedCost);
        const benefit = (tokenPct !== null && tokenPct <= -this.config.minimumTokenOrCostImprovementPct) || (costPct !== null && costPct <= -this.config.minimumTokenOrCostImprovementPct);
        if (!benefit) soft.push('NO_MEASURABLE_CANARY_BENEFIT');
        if (soft.length) {
          status = GuardrailStatus.HOLD_FOR_REVIEW;
          reasonCodes.push(...soft);
        } else {
          status = GuardrailStatus.ELIGIBLE_FOR_PROMOTION;
          reasonCodes.push('CANARY_HARD_GUARDRAILS_PASSED', 'CANARY_SOFT_GUARDRAILS_PASSED');
        }
      }
    }

    const guardrailResults = Object.freeze({
      status,
      reasonCodes: Object.freeze([...reasonCodes]),
      promotionEligible: status === GuardrailStatus.ELIGIBLE_FOR_PROMOTION,
    });
    const body = {
      policyVersion,
      baselinePolicyVersion,
      stage,
      requestCount: candidateMetrics.requestCount,
      observationStart: start,
      observationEnd: end,
      candidateMetrics,
      baselineMetrics,
      guardrailResults,
    };
    const contentHash = sha256(canonicalJson(body));
    return Object.freeze({
      snapshotId: `canary-${contentHash.slice(0, 20)}`,
      ...body,
      contentHash,
    });
  }
}
