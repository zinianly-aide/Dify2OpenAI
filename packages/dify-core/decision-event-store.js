import { canonicalJson, sha256 } from './canonical.js';

const SAFE_ARRAY_FIELDS = new Set(['routingReasonCodes']);

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function bool(value) { return value === true; }
function text(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value).slice(0, 256);
}
function safeCodes(value) {
  return Array.isArray(value)
    ? Object.freeze([...new Set(value.map((item) => String(item).replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 96)))].sort())
    : Object.freeze([]);
}

export function normalizeDecisionEvent(input = {}) {
  const timestamp = text(input.timestamp || input.ts || input.createdAt) || new Date().toISOString();
  const event = {
    timestamp,
    traceId: text(input.traceId),
    sessionIdHash: text(input.sessionIdHash),
    clientType: text(input.clientType, 'unknown'),
    taskType: text(input.taskType, 'unknown'),
    backendId: text(input.backendId || input.routingSelectedBackend),
    model: text(input.model),
    policyVersion: text(input.policyVersion, 'unknown'),
    estimatedInputTokens: finite(input.estimatedInputTokens ?? input.estimatedPromptTokens ?? input.gatewayEstimatedInputTokens),
    compressedTokens: finite(input.compressedTokens ?? input.gatewayCompressedTokens ?? input.compressionAfterTokens),
    backendPromptTokens: finite(input.backendPromptTokens),
    completionTokens: finite(input.completionTokens ?? input.backendCompletionTokens),
    contextWindow: finite(input.contextWindow),
    contextUtilization: finite(input.contextUtilization ?? input.backendContextUtilization),
    contextAmplification: finite(input.contextAmplification),
    compressionMode: text(input.compressionMode, 'none'),
    compressionPasses: finite(input.compressionPasses) ?? 0,
    checkpointCreated: bool(input.checkpointCreated),
    rotationOccurred: bool(input.rotationOccurred ?? input.rotationStarted ?? input.rotationSuccess),
    toolCountBefore: finite(input.toolCountBefore) ?? 0,
    toolCountAfter: finite(input.toolCountAfter) ?? 0,
    toolSchemaTokensBefore: finite(input.toolSchemaTokensBefore) ?? 0,
    toolSchemaTokensAfter: finite(input.toolSchemaTokensAfter) ?? 0,
    toolSchemaTokensSaved: finite(input.toolSchemaTokensSaved) ?? 0,
    toolRecoveryTriggered: bool(input.toolRecoveryTriggered),
    toolRecoverySuccess: bool(input.toolRecoverySuccess),
    toolPruningConfidence: text(input.toolPruningConfidence),
    toolPruningConfidenceScore: finite(input.toolPruningConfidenceScore),
    toolSuccessRate: finite(input.toolSuccessRate),
    routingReasonCodes: safeCodes(input.routingReasonCodes),
    migrationOccurred: bool(input.migrationOccurred ?? input.migrationStarted ?? input.routingMigrationRequired),
    fallbackUsed: bool(input.fallbackUsed ?? input.routingFallbackUsed),
    latencyMs: finite(input.latencyMs),
    firstTokenLatencyMs: finite(input.firstTokenLatencyMs),
    success: bool(input.success),
    errorType: text(input.errorType),
    retryCount: finite(input.retryCount) ?? 0,
    estimatedCost: finite(input.estimatedCost),
    requiresTools: bool(input.requiresTools),
    hasImages: bool(input.hasImages),
    reasoningRequired: bool(input.reasoningRequired),
    streamingRequired: bool(input.streamingRequired),
    portableContextAvailable: input.portableContextAvailable === undefined ? null : bool(input.portableContextAvailable),
    previousBackendId: text(input.previousBackendId || input.routingPreviousBackend),
  };
  return Object.freeze(event);
}

function sortedEvents(events) {
  return [...events].sort((a, b) =>
    String(a.timestamp).localeCompare(String(b.timestamp))
    || String(a.traceId || '').localeCompare(String(b.traceId || ''))
    || String(a.sessionIdHash || '').localeCompare(String(b.sessionIdHash || '')));
}

export function createDatasetSnapshot(events = [], { datasetId } = {}) {
  const normalized = sortedEvents(events.map((event) => normalizeDecisionEvent(event)));
  const sourcePolicyVersions = [...new Set(normalized.map((event) => event.policyVersion))].sort();
  const contentHash = sha256(canonicalJson(normalized));
  const resolvedDatasetId = datasetId || `dataset-${contentHash.slice(0, 20)}`;
  return Object.freeze({
    datasetId: resolvedDatasetId,
    eventCount: normalized.length,
    startTime: normalized[0]?.timestamp ?? null,
    endTime: normalized.at(-1)?.timestamp ?? null,
    sourcePolicyVersions: Object.freeze(sourcePolicyVersions),
    contentHash,
    mixedPolicyVersions: sourcePolicyVersions.length > 1,
    events: Object.freeze(normalized),
  });
}

export class DecisionEventStore {
  constructor() { this.events = []; }

  append(input) {
    const event = normalizeDecisionEvent(input);
    this.events.push(event);
    return event;
  }

  appendMany(inputs = []) { return inputs.map((input) => this.append(input)); }

  list({ policyVersion, clientType, taskType, backendId, model } = {}) {
    return this.events.filter((event) => {
      if (policyVersion !== undefined && event.policyVersion !== policyVersion) return false;
      if (clientType !== undefined && event.clientType !== clientType) return false;
      if (taskType !== undefined && event.taskType !== taskType) return false;
      if (backendId !== undefined && event.backendId !== backendId) return false;
      if (model !== undefined && event.model !== model) return false;
      return true;
    });
  }

  snapshot(options = {}) { return createDatasetSnapshot(this.list(options), options); }
  clear() { this.events.length = 0; }
}

export const DECISION_EVENT_SAFE_ARRAY_FIELDS = SAFE_ARRAY_FIELDS;
