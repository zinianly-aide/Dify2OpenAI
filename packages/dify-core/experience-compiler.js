import { sha256 } from './canonical.js';
import { KnowledgeScope, createKnowledgeExperience } from './knowledge-experience.js';

function num(value, fallback = 0) { const n = Number(value); return Number.isFinite(n) ? n : fallback; }
function bool(value) { return value === true; }
function text(value, fallback = 'unknown') { return value === undefined || value === null || value === '' ? fallback : String(value).slice(0, 128); }
function codes(value) { return Object.freeze([...new Set(Array.isArray(value) ? value.map((v) => text(v)) : [])].sort()); }
function bucket(value, cuts, labels) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return 'UNKNOWN';
  const n = Number(value);
  for (let i = 0; i < cuts.length; i += 1) if (n < cuts[i]) return labels[i];
  return labels.at(-1);
}
function modelFamily(model) { return text(model).split(/[-_:/.]/)[0].toLowerCase(); }
function backendType(event) { return text(event.backendType || event.providerType || event.backend?.type); }
function backendHash(event) {
  const id = event.backendId || event.routingSelectedBackend || event.backend?.id;
  return id ? `backend-${sha256(String(id)).slice(0, 16)}` : 'backend-unknown';
}

export function classifyKnowledgeScope(event = {}) {
  if (event.versionSpecific === true || event.policyVersionSpecific === true) return KnowledgeScope.VERSION_SPECIFIC;
  if (event.modelSpecific === true) return KnowledgeScope.MODEL_SPECIFIC;
  if (event.backendSpecific === true || backendType(event) !== 'unknown') return KnowledgeScope.BACKEND_SPECIFIC;
  if (event.clientSpecific === true || text(event.clientType) !== 'unknown') return KnowledgeScope.CLIENT_SPECIFIC;
  return KnowledgeScope.GENERAL;
}

export class ExperienceCompiler {
  compile(event = {}, { sourceType = 'RuntimeEvent', sourceId = null } = {}) {
    const scope = classifyKnowledgeScope(event);
    return createKnowledgeExperience({
      timestamp: text(event.timestamp || event.ts || event.createdAt, 'unknown'),
      clientType: text(event.clientType),
      taskType: text(event.taskType),
      backendType: backendType(event),
      backendIdHash: backendHash(event),
      modelFamily: modelFamily(event.model || event.modelFamily),
      context: Object.freeze({
        utilization: num(event.contextUtilization, null),
        amplification: num(event.contextAmplification, null),
        compressionMode: text(event.compressionMode, 'none'),
        checkpoint: bool(event.checkpointCreated || event.checkpoint),
        rotation: bool(event.rotationOccurred || event.rotationStarted || event.rotationSuccess),
      }),
      tools: Object.freeze({
        beforeCount: num(event.toolCountBefore),
        afterCount: num(event.toolCountAfter),
        schemaTokensSaved: num(event.toolSchemaTokensSaved),
        pruningMode: text(event.toolPruningMode || event.toolPruningConfidence, 'none'),
        recoveryTriggered: bool(event.toolRecoveryTriggered),
      }),
      routing: Object.freeze({
        migration: bool(event.migrationOccurred || event.migrationStarted || event.routingMigrationRequired),
        fallback: bool(event.fallbackUsed || event.routingFallbackUsed),
        reasonCodes: codes(event.routingReasonCodes || event.reasonCodes),
      }),
      outcome: Object.freeze({
        success: bool(event.success),
        errorType: event.errorType ? text(event.errorType) : null,
        latencyBucket: bucket(event.latencyMs, [250, 1000, 5000, Infinity], ['LT_250MS', 'LT_1S', 'LT_5S', 'GE_5S']),
        tokenBucket: bucket(event.backendPromptTokens ?? event.estimatedInputTokens, [1000, 8000, 32000, Infinity], ['LT_1K', 'LT_8K', 'LT_32K', 'GE_32K']),
        costBucket: bucket(event.estimatedCost, [0.001, 0.01, 0.1, Infinity], ['LT_0_001', 'LT_0_01', 'LT_0_1', 'GE_0_1']),
      }),
      policyVersion: text(event.policyVersion),
      scope,
      source: Object.freeze({ type: text(sourceType), idHash: sourceId ? sha256(String(sourceId)).slice(0, 16) : null }),
    });
  }
}
