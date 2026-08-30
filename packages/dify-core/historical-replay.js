import { CompressionPolicy, DEFAULT_COMPRESSION_CONFIG } from './compression-policy.js';
import { CheckpointRecommendation, DEFAULT_CHECKPOINT_RECOMMENDATION_CONFIG } from './backend-context.js';
import { BackendRegistry } from './backend-registry.js';
import { DeterministicBackendRouter, isFallbackEligible } from './backend-router.js';
import { ToolRelevancePolicy } from './tool-optimization.js';
import { validatePolicyCandidate } from './policy-candidate.js';

export const HISTORICAL_REPLAY_VERSION = 'historical-replay-v1';

export const DEFAULT_REPLAY_POLICY = Object.freeze({
  compression: Object.freeze({ ...DEFAULT_COMPRESSION_CONFIG, targetUtilization: 0.68 }),
  checkpoint: Object.freeze({ ...DEFAULT_CHECKPOINT_RECOMMENDATION_CONFIG }),
  backendPriority: Object.freeze({}),
  backendHealth: Object.freeze({}),
  tool: Object.freeze({ pruningConfidenceThreshold: 0.65, recoveryLimit: 1 }),
});

function mergePolicy(base = {}, changes = {}) {
  return Object.freeze({
    compression: Object.freeze({ ...DEFAULT_REPLAY_POLICY.compression, ...(base.compression || {}), ...(changes.compression || {}) }),
    checkpoint: Object.freeze({ ...DEFAULT_REPLAY_POLICY.checkpoint, ...(base.checkpoint || {}), ...(changes.checkpoint || {}) }),
    backendPriority: Object.freeze({ ...DEFAULT_REPLAY_POLICY.backendPriority, ...(base.backendPriority || {}), ...(changes.backendPriority || {}) }),
    backendHealth: Object.freeze({ ...DEFAULT_REPLAY_POLICY.backendHealth, ...(base.backendHealth || {}), ...(changes.backendHealth || {}) }),
    tool: Object.freeze({ ...DEFAULT_REPLAY_POLICY.tool, ...(base.tool || {}), ...(changes.tool || {}) }),
  });
}

function compressionFactor(mode) { if (mode === 'heavy') return 0.65; if (mode === 'light') return 0.82; if (mode === 'tool_prune') return 0.97; return 1; }
function estimateTokens(event, compressionDecision) {
  const estimated = Math.max(0, Number(event.estimatedInputTokens || 0));
  if (String(compressionDecision.mode) === String(event.compressionMode) && Number.isFinite(Number(event.compressedTokens))) return Number(event.compressedTokens);
  return Math.round(estimated * compressionFactor(compressionDecision.mode));
}
function cloneRegistry(registry, policy) {
  if (!registry) return null;
  return new BackendRegistry(registry.list({ enabledOnly: false }).map((backend) => ({
    backendId: backend.backendId, providerType: backend.providerType, baseUrl: backend.baseUrl, model: backend.model, enabled: backend.enabled,
    priority: policy.backendPriority[backend.backendId] ?? backend.priority,
    maxContextWindow: backend.capabilities.maxContextWindow, supportsTools: backend.capabilities.supportsTools,
    supportsVision: backend.capabilities.supportsVision, supportsStreaming: backend.capabilities.supportsStreaming,
    supportsReasoning: backend.capabilities.supportsReasoning, statefulContext: backend.capabilities.contextMode === 'stateful', costTier: backend.capabilities.costTier,
  })));
}
function syntheticToolInput(event, threshold) {
  const count = Math.max(0, Math.round(Number(event.toolCountBefore || 0)));
  const tools = Array.from({ length: count }, (_, index) => ({ type: 'function', function: { name: `replay_tool_${index}`, description: 'replay metadata only', parameters: { type: 'object' } } }));
  const observedScore = Number.isFinite(Number(event.toolPruningConfidenceScore)) ? Number(event.toolPruningConfidenceScore) : event.toolPruningConfidence === 'high' ? 0.75 : 0;
  const profile = { recentlyUsedTools: observedScore >= 0.75 && count ? ['replay_tool_0'] : [], toolUsageFrequency: observedScore >= 0.75 && count ? { replay_tool_0: 1 } : {}, pendingTools: [] };
  return new ToolRelevancePolicy({ pruningConfidenceThreshold: threshold }).classify({ canonicalRequest: { clientType: event.clientType, taskType: event.taskType }, tools, profile, backendCapabilities: { supportsTools: true }, explicitRequiredTools: observedScore >= 1 && count ? ['replay_tool_0'] : [] });
}
function toolPrediction(event, policyResult) {
  const beforeCount = Math.max(0, Number(event.toolCountBefore || 0));
  const beforeTokens = Math.max(0, Number(event.toolSchemaTokensBefore || 0));
  if (!beforeCount || policyResult.confidence !== 'high') return { pruning: false, toolCount: beforeCount, schemaTokens: beforeTokens };
  const observedRatio = beforeCount > 0 && Number(event.toolCountAfter) < beforeCount ? Math.max(1 / beforeCount, Number(event.toolCountAfter) / beforeCount) : 0.75;
  const afterCount = Math.max(1, Math.round(beforeCount * observedRatio));
  return { pruning: afterCount < beforeCount, toolCount: afterCount, schemaTokens: Math.round(beforeTokens * (afterCount / beforeCount)) };
}
function costEstimate(event, tokenEstimate, schemaTokens) {
  const observedCost = Number(event.estimatedCost);
  if (!Number.isFinite(observedCost)) return 0;
  const baselineUnits = Math.max(1, Number(event.compressedTokens || event.estimatedInputTokens || 0) + Number(event.toolSchemaTokensAfter || 0));
  return observedCost * ((tokenEstimate + schemaTokens) / baselineUnits);
}
function fallbackPredicted(event, routing) {
  const errorType = String(event.errorType || '').toUpperCase();
  const eligible = isFallbackEligible({ code: errorType, status: /^HTTP_5\d\d$/.test(errorType) ? Number(errorType.slice(5)) : undefined });
  return Boolean(eligible && routing?.fallbackChain?.length);
}
function replayOne(event, policy, registry) {
  const compression = new CompressionPolicy(policy.compression).decide({ contextUtilization: event.contextUtilization, clientType: event.clientType, backendId: event.backendId, model: event.model, estimatedPromptTokens: event.estimatedInputTokens, contextWindow: event.contextWindow, messageCount: 0, toolSchemaTokens: event.toolSchemaTokensBefore });
  let estimatedTokens = estimateTokens(event, compression);
  const checkpoint = new CheckpointRecommendation({ config: policy.checkpoint }).recommend({ compressionResult: { unableToReachTarget: false }, reconciliation: { contextAmplification: Number.isFinite(Number(event.contextAmplification)) ? Number(event.contextAmplification) : undefined, backendContextUtilization: Number.isFinite(Number(event.contextUtilization)) ? Number(event.contextUtilization) : undefined } });
  if (checkpoint.recommended) estimatedTokens = Math.round(estimatedTokens * 0.65);
  const tool = toolPrediction(event, syntheticToolInput(event, policy.tool.pruningConfidenceThreshold));
  const replayRegistry = cloneRegistry(registry, policy);
  let routing = { backendId: event.backendId, fallbackChain: [], migrationRequired: false, reasonCodes: ['REPLAY_NO_REGISTRY'] };
  if (replayRegistry) routing = new DeterministicBackendRouter({ registry: replayRegistry, policyVersion: 'offline-replay-router-v1' }).decide({ taskType: event.taskType, currentBackendId: event.previousBackendId || undefined, estimatedTokens, contextUtilization: event.contextUtilization, requiresTools: event.requiresTools, hasImages: event.hasImages, reasoningRequired: event.reasoningRequired, streamingRequired: event.streamingRequired });
  const selected = replayRegistry?.get(routing.backendId) || null;
  let capabilityViolation = 0;
  if (selected && event.requiresTools && !selected.capabilities.supportsTools) capabilityViolation += 1;
  if (selected && event.hasImages && !selected.capabilities.supportsVision) capabilityViolation += 1;
  if (selected && event.reasoningRequired && !selected.capabilities.supportsReasoning) capabilityViolation += 1;
  if (routing.migrationRequired && event.portableContextAvailable === false) capabilityViolation += 1;
  const unsupported = routing.backendId == null ? 1 : 0;
  const maxContext = selected?.capabilities?.maxContextWindow || Number(event.contextWindow) || null;
  const overflow = maxContext && estimatedTokens > maxContext ? 1 : unsupported;
  return { estimatedTokens, estimatedCost: costEstimate(event, estimatedTokens, tool.schemaTokens), compression: compression.mode !== 'none', checkpoint: checkpoint.recommended, fallback: fallbackPredicted(event, routing), toolPruning: tool.pruning, overflow, backendId: routing.backendId, capabilityViolation, unsupported, schemaTokens: tool.schemaTokens };
}
function aggregate(results) {
  return Object.freeze({ estimatedTokens: results.reduce((sum, item) => sum + item.estimatedTokens, 0), estimatedCost: results.reduce((sum, item) => sum + item.estimatedCost, 0), compressionCount: results.filter((item) => item.compression).length, checkpointCount: results.filter((item) => item.checkpoint).length, fallbackCount: results.filter((item) => item.fallback).length, toolPruningCount: results.filter((item) => item.toolPruning).length, predictedOverflowCount: results.reduce((sum, item) => sum + item.overflow, 0), predictedToolSchemaTokens: results.reduce((sum, item) => sum + item.schemaTokens, 0) });
}
function pct(candidate, baseline) { if (!baseline) return candidate === baseline ? 0 : null; return ((candidate - baseline) / baseline) * 100; }

export class HistoricalReplay {
  constructor({ registry, replayVersion = HISTORICAL_REPLAY_VERSION, analyzerVersion = 'offline-policy-analyzer-v1' } = {}) { this.registry = registry; this.replayVersion = replayVersion; this.analyzerVersion = analyzerVersion; }
  replay({ snapshot, baselinePolicy = {}, candidate } = {}) {
    const validation = validatePolicyCandidate(candidate);
    if (!validation.valid) { const error = new Error(`POLICY_CANDIDATE_INVALID:${validation.errors.join(',')}`); error.code = 'POLICY_CANDIDATE_INVALID'; error.validation = validation; throw error; }
    const events = [...(snapshot?.events || [])];
    const baseline = mergePolicy(baselinePolicy);
    const candidatePolicy = mergePolicy(baselinePolicy, candidate.changes);
    const baselineResults = events.map((event) => replayOne(event, baseline, this.registry));
    const candidateResults = events.map((event) => replayOne(event, candidatePolicy, this.registry));
    const baselineMetrics = aggregate(baselineResults);
    const candidateMetrics = aggregate(candidateResults);
    const driftCount = candidateResults.filter((item, index) => item.backendId !== baselineResults[index].backendId).length;
    const baselineRecoveryRate = events.length ? events.filter((event) => event.toolRecoveryTriggered).length / events.length : 0;
    const newlyPruned = candidateResults.filter((item, index) => item.toolPruning && !baselineResults[index].toolPruning).length;
    const noLongerPruned = candidateResults.filter((item, index) => !item.toolPruning && baselineResults[index].toolPruning).length;
    const toolRecoveryRisk = Math.max(0, Math.min(1, baselineRecoveryRate + (newlyPruned * 0.04 - noLongerPruned * 0.03) / Math.max(events.length, 1)));
    const capabilityViolationCount = candidateResults.reduce((sum, item) => sum + item.capabilityViolation, 0);
    const backendHealthReplayUnsupported = Object.keys(candidate.changes?.backendHealth || {}).length > 0;
    const unsupportedDecisionCount = candidateResults.reduce((sum, item) => sum + item.unsupported, 0) + (backendHealthReplayUnsupported ? events.length : 0);
    const sourcePolicyVersions = snapshot?.sourcePolicyVersions || [...new Set(events.map((event) => event.policyVersion))].sort();
    const basePolicyMismatchCount = events.filter((event) => event.policyVersion !== candidate.basePolicyVersion).length;
    return Object.freeze({
      requestCount: events.length, basePolicyVersion: candidate.basePolicyVersion, candidateId: candidate.candidateId, analyzerVersion: this.analyzerVersion, replayVersion: this.replayVersion,
      dataset: Object.freeze({ datasetId: snapshot?.datasetId ?? null, contentHash: snapshot?.contentHash ?? null, sourcePolicyVersions: Object.freeze([...sourcePolicyVersions]), mixedPolicyVersions: sourcePolicyVersions.length > 1, basePolicyMismatchCount }),
      semantics: Object.freeze({ historical: 'observed', baseline: 'deterministic_replay_estimated', candidate: 'deterministic_replay_predicted', futureLatency: 'not_replayed', futureAnswerQuality: 'not_replayed', futureToolSuccess: 'not_replayed', backendHealthThresholds: backendHealthReplayUnsupported ? 'unsupported_without_historical_health_samples' : 'unchanged_or_not_applicable' }),
      baseline: baselineMetrics, candidate: candidateMetrics,
      delta: Object.freeze({ tokenPct: pct(candidateMetrics.estimatedTokens, baselineMetrics.estimatedTokens), costPct: pct(candidateMetrics.estimatedCost, baselineMetrics.estimatedCost), checkpointPct: pct(candidateMetrics.checkpointCount, baselineMetrics.checkpointCount), fallbackPct: pct(candidateMetrics.fallbackCount, baselineMetrics.fallbackCount), overflowPct: pct(candidateMetrics.predictedOverflowCount, baselineMetrics.predictedOverflowCount) }),
      risk: Object.freeze({ routingDrift: events.length ? driftCount / events.length : 0, toolRecoveryRisk, capabilityViolationCount, unsupportedDecisionCount }),
    });
  }
}
