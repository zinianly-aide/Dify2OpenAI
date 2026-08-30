import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BackendProviderType,
  BackendRegistry,
  HistoricalReplay,
  PolicyEvaluation,
  PolicyEvaluator,
  createDatasetSnapshot,
  validatePolicyCandidate,
} from '../packages/dify-core/index.js';

function candidate(changes) {
  return {
    candidateId: 'pc-guardrail',
    basePolicyVersion: 'policy-v1',
    changes,
    evidence: { requestCount: 20 },
    hypothesis: 'Guardrail fixture.',
    expectedImpact: { kind: 'predicted' },
    confidence: 'medium',
    createdAt: '2026-08-30T00:00:00.000Z',
  };
}

function event(index) {
  return {
    timestamp: `2026-08-30T00:${String(index).padStart(2, '0')}:00.000Z`, traceId: `t-${index}`, sessionIdHash: `s-${index}`,
    clientType: 'dsh', taskType: 'coding', backendId: 'tools', model: 'm', policyVersion: 'policy-v1',
    estimatedInputTokens: 1000, compressedTokens: 1000, backendPromptTokens: 1000, completionTokens: 50,
    contextWindow: 10000, contextUtilization: 0.1, contextAmplification: 1, compressionMode: 'none', compressionPasses: 0,
    checkpointCreated: false, rotationOccurred: false, toolCountBefore: 2, toolCountAfter: 2,
    toolSchemaTokensBefore: 100, toolSchemaTokensAfter: 100, toolSchemaTokensSaved: 0,
    toolRecoveryTriggered: false, toolPruningConfidence: 'low', toolPruningConfidenceScore: 0,
    routingReasonCodes: [], migrationOccurred: false, fallbackUsed: false, latencyMs: 100, firstTokenLatencyMs: 20,
    success: true, retryCount: 0, estimatedCost: 1, requiresTools: true, hasImages: false, portableContextAvailable: true,
  };
}

function registry() {
  return new BackendRegistry([{ backendId: 'tools', providerType: BackendProviderType.OPENAI_COMPATIBLE, baseUrl: 'http://tools/v1', model: 'm', enabled: true, priority: 1, maxContextWindow: 10000, supportsTools: true, supportsVision: true, supportsStreaming: true, supportsReasoning: true, costTier: 'low' }]);
}

test('partial compression threshold candidate is range/order validated against baseline defaults', () => {
  const invalid = candidate({ compression: { heavyThreshold: 0.60 } });
  const validation = validatePolicyCandidate(invalid);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.includes('COMPRESSION_THRESHOLDS_ORDER_INVALID'));
  const evaluation = new PolicyEvaluator().evaluate({ candidate: invalid, replayResult: null });
  assert.equal(evaluation.conclusion, PolicyEvaluation.REJECT);
});

test('backend health threshold change is explicitly unsupported without historical health samples and therefore rejected', () => {
  const snapshot = createDatasetSnapshot(Array.from({ length: 20 }, (_, i) => event(i)));
  const c = candidate({ backendHealth: { unavailableConsecutiveFailures: 4 } });
  const replay = new HistoricalReplay({ registry: registry() }).replay({ snapshot, baselinePolicy: {}, candidate: c });
  assert.equal(replay.semantics.backendHealthThresholds, 'unsupported_without_historical_health_samples');
  assert.equal(replay.risk.unsupportedDecisionCount, 20);
  const evaluation = new PolicyEvaluator().evaluate({ candidate: c, replayResult: replay });
  assert.equal(evaluation.conclusion, PolicyEvaluation.REJECT);
  assert.ok(evaluation.reasonCodes.includes('UNSUPPORTED_DECISION'));
});
