import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BackendProviderType,
  BackendRegistry,
  DecisionEventStore,
  DeterministicPolicyCandidateGenerator,
  HistoricalReplay,
  OfflinePolicyAnalyzer,
  PolicyEvaluation,
  PolicyEvaluator,
  createDatasetSnapshot,
  createPolicyCandidateReport,
  validatePolicyCandidate,
} from '../packages/dify-core/index.js';

function event(index, overrides = {}) {
  return {
    timestamp: `2026-08-30T00:${String(index).padStart(2, '0')}:00.000Z`,
    traceId: `trace-${index}`,
    sessionIdHash: `hash-${index % 3}`,
    clientType: 'dsh',
    taskType: 'coding',
    backendId: 'fast-tools',
    model: 'model-a',
    policyVersion: 'policy-v1',
    estimatedInputTokens: 4000,
    compressedTokens: 4000,
    backendPromptTokens: 4200,
    completionTokens: 200,
    contextWindow: 10000,
    contextUtilization: 0.4,
    contextAmplification: 1.05,
    compressionMode: 'none',
    compressionPasses: 0,
    checkpointCreated: false,
    rotationOccurred: false,
    toolCountBefore: 25,
    toolCountAfter: 25,
    toolSchemaTokensBefore: 1500,
    toolSchemaTokensAfter: 1500,
    toolSchemaTokensSaved: 0,
    toolRecoveryTriggered: false,
    toolRecoverySuccess: false,
    toolPruningConfidence: 'high',
    toolPruningConfidenceScore: 0.75,
    routingReasonCodes: ['SESSION_AFFINITY'],
    migrationOccurred: false,
    fallbackUsed: false,
    latencyMs: 500,
    firstTokenLatencyMs: 120,
    success: true,
    errorType: null,
    retryCount: 0,
    estimatedCost: 1,
    requiresTools: true,
    hasImages: false,
    portableContextAvailable: true,
    ...overrides,
  };
}

function registry() {
  return new BackendRegistry([
    {
      backendId: 'fast-tools', providerType: BackendProviderType.OPENAI_COMPATIBLE, baseUrl: 'http://fast/v1', model: 'model-a', enabled: true,
      priority: 10, maxContextWindow: 120000, supportsTools: true, supportsVision: true, supportsReasoning: true, supportsStreaming: true, costTier: 'medium',
    },
    {
      backendId: 'slow-tools', providerType: BackendProviderType.OPENAI_COMPATIBLE, baseUrl: 'http://slow/v1', model: 'model-b', enabled: true,
      priority: 20, maxContextWindow: 120000, supportsTools: true, supportsVision: true, supportsReasoning: true, supportsStreaming: true, costTier: 'medium',
    },
    {
      backendId: 'no-tools', providerType: BackendProviderType.OPENAI_COMPATIBLE, baseUrl: 'http://no-tools/v1', model: 'model-c', enabled: true,
      priority: 5, maxContextWindow: 120000, supportsTools: false, supportsVision: false, supportsReasoning: false, supportsStreaming: true, costTier: 'low',
    },
  ]);
}

function validCandidate(overrides = {}) {
  return {
    candidateId: 'pc-test',
    basePolicyVersion: 'policy-v1',
    changes: { checkpoint: { backendContextUtilizationThreshold: 0.82 } },
    evidence: { requestCount: 40 },
    hypothesis: 'Earlier checkpoint may reduce predicted overflow.',
    expectedImpact: { overflow: 'decrease_predicted' },
    confidence: 'medium',
    createdAt: '2026-08-30T00:40:00.000Z',
    ...overrides,
  };
}

test('DecisionEventStore saves only sanitized whitelist fields and creates immutable reproducible snapshot', () => {
  const store = new DecisionEventStore();
  store.append({
    ...event(1),
    rawPrompt: 'SECRET_PROMPT', rawSessionId: 'raw-session', conversationId: 'conv-secret',
    toolSchema: { secret: 'schema' }, toolArguments: { secret: 'args' }, toolResult: 'SECRET_RESULT', apiKey: 'sk-secret', attachmentContent: 'bytes',
  });
  const snapshotA = store.snapshot();
  const snapshotB = store.snapshot();
  assert.deepEqual(snapshotA, snapshotB);
  assert.equal(snapshotA.datasetId, snapshotB.datasetId);
  assert.equal(snapshotA.contentHash, snapshotB.contentHash);
  const serialized = JSON.stringify(snapshotA);
  for (const secret of ['SECRET_PROMPT', 'raw-session', 'conv-secret', 'SECRET_RESULT', 'sk-secret', 'attachmentContent', 'toolArguments']) {
    assert.equal(serialized.includes(secret), false);
  }
  assert.equal(snapshotA.eventCount, 1);
});

test('OfflinePolicyAnalyzer aggregates required dimensions and observed statistics deterministically', () => {
  const events = [
    event(1, { compressionMode: 'light', compressedTokens: 3200, toolCountAfter: 8, toolSchemaTokensAfter: 500, toolSchemaTokensSaved: 1000 }),
    event(2, { success: false, errorType: 'TIMEOUT', fallbackUsed: true, latencyMs: 3000, firstTokenLatencyMs: 700, toolRecoveryTriggered: true }),
    event(3, { checkpointCreated: true, rotationOccurred: true, contextAmplification: 2.5, contextUtilization: 0.95 }),
  ];
  const analyzer = new OfflinePolicyAnalyzer();
  const a = analyzer.analyze(events);
  const b = analyzer.analyze(events);
  assert.deepEqual(a, b);
  assert.equal(a.requestCount, 3);
  assert.equal(a.overall.successRate, 2 / 3);
  assert.equal(a.overall.compressionFrequency, 1 / 3);
  assert.equal(a.overall.toolPruningRate, 1 / 3);
  assert.equal(a.overall.toolRecoveryRate, 1 / 3);
  assert.equal(a.overall.fallbackRate, 1 / 3);
  assert.equal(a.overall.latencyMs.p95, 3000);
});

test('high context usage deterministically generates earlier-checkpoint candidate', () => {
  const events = Array.from({ length: 30 }, (_, i) => event(i, { contextUtilization: 0.86 }));
  const snapshot = createDatasetSnapshot(events);
  const analysis = new OfflinePolicyAnalyzer().analyze(snapshot);
  const generated = new DeterministicPolicyCandidateGenerator({ minimumEvidence: 20 }).generate({
    analysis, snapshot, basePolicyVersion: 'policy-v1', baselinePolicy: { checkpoint: { backendContextUtilizationThreshold: 0.90 } },
  });
  assert.equal(generated.status, 'CANDIDATES');
  assert.ok(generated.candidates.some((candidate) => candidate.changes.checkpoint?.backendContextUtilizationThreshold < 0.90));
});

test('high backend latency proxy with compatible backend generates routing priority candidate', () => {
  const events = Array.from({ length: 25 }, (_, i) => event(i, { backendId: 'slow-tools', model: 'model-b', latencyMs: 4000 }));
  const snapshot = createDatasetSnapshot(events);
  const analysis = new OfflinePolicyAnalyzer().analyze(snapshot);
  const generated = new DeterministicPolicyCandidateGenerator({ minimumEvidence: 20, highBackendP95Ms: 2500 }).generate({
    analysis, snapshot, basePolicyVersion: 'policy-v1', baselinePolicy: { backendPriority: { 'slow-tools': 20 } }, compatibleBackendIds: ['slow-tools', 'fast-tools'],
  });
  assert.ok(generated.candidates.some((candidate) => candidate.changes.backendPriority?.['slow-tools'] > 20));
});

test('high tool schema cost plus low recovery generates stronger pruning candidate', () => {
  const events = Array.from({ length: 30 }, (_, i) => event(i, { toolSchemaTokensBefore: 3000, toolSchemaTokensAfter: 2500, toolSchemaTokensSaved: 500, toolRecoveryTriggered: false }));
  const snapshot = createDatasetSnapshot(events);
  const analysis = new OfflinePolicyAnalyzer().analyze(snapshot);
  const generated = new DeterministicPolicyCandidateGenerator({ minimumEvidence: 20 }).generate({
    analysis, snapshot, basePolicyVersion: 'policy-v1', baselinePolicy: { tool: { pruningConfidenceThreshold: 0.65 } },
  });
  assert.ok(generated.candidates.some((candidate) => candidate.changes.tool?.pruningConfidenceThreshold < 0.65));
});

test('insufficient evidence returns NO_CANDIDATE instead of inventing policy', () => {
  const snapshot = createDatasetSnapshot(Array.from({ length: 5 }, (_, i) => event(i, { contextUtilization: 0.99, latencyMs: 9000 })));
  const analysis = new OfflinePolicyAnalyzer().analyze(snapshot);
  const generated = new DeterministicPolicyCandidateGenerator({ minimumEvidence: 20 }).generate({ analysis, snapshot, basePolicyVersion: 'policy-v1' });
  assert.equal(generated.status, 'NO_CANDIDATE');
  assert.deepEqual(generated.candidates, []);
});

test('candidate schema invalid and out-of-range values are rejected', () => {
  const invalidField = validCandidate({ changes: { dangerousScript: { code: 'run()' } } });
  assert.equal(validatePolicyCandidate(invalidField).valid, false);
  const invalidValue = validCandidate({ changes: { tool: { recoveryLimit: 99 } } });
  assert.equal(validatePolicyCandidate(invalidValue).valid, false);
  const evaluator = new PolicyEvaluator();
  assert.equal(evaluator.evaluate({ candidate: invalidValue, replayResult: null }).conclusion, PolicyEvaluation.REJECT);
});

test('same historical snapshot baseline and candidate replay twice yields identical result', () => {
  const snapshot = createDatasetSnapshot(Array.from({ length: 12 }, (_, i) => event(i, { contextUtilization: i % 2 ? 0.85 : 0.65 })));
  const replay = new HistoricalReplay({ registry: registry() });
  const candidate = validCandidate();
  const first = replay.replay({ snapshot, baselinePolicy: {}, candidate });
  const second = replay.replay({ snapshot, baselinePolicy: {}, candidate });
  assert.deepEqual(first, second);
  assert.equal(first.semantics.futureLatency, 'not_replayed');
  assert.equal(first.semantics.futureAnswerQuality, 'not_replayed');
  assert.equal(first.semantics.futureToolSuccess, 'not_replayed');
});

test('mixed policy-version dataset is explicitly reported with mismatch count', () => {
  const snapshot = createDatasetSnapshot([event(1), event(2, { policyVersion: 'policy-v2' })]);
  const replay = new HistoricalReplay({ registry: registry() }).replay({ snapshot, baselinePolicy: {}, candidate: validCandidate() });
  assert.equal(snapshot.mixedPolicyVersions, true);
  assert.deepEqual(snapshot.sourcePolicyVersions, ['policy-v1', 'policy-v2']);
  assert.equal(replay.dataset.mixedPolicyVersions, true);
  assert.equal(replay.dataset.basePolicyMismatchCount, 1);
});

test('Case A: large safe token/cost/overflow improvement is ACCEPT_FOR_CANARY', () => {
  const candidate = validCandidate();
  const replayResult = {
    candidateId: candidate.candidateId,
    basePolicyVersion: candidate.basePolicyVersion,
    baseline: { estimatedTokens: 100000, estimatedCost: 100, predictedOverflowCount: 20, fallbackCount: 4 },
    candidate: { estimatedTokens: 78000, estimatedCost: 84, predictedOverflowCount: 8, fallbackCount: 4 },
    delta: { tokenPct: -22, costPct: -16, overflowPct: -60, fallbackPct: 0 },
    risk: { routingDrift: 0.05, toolRecoveryRisk: 0.01, capabilityViolationCount: 0, unsupportedDecisionCount: 0 },
    dataset: { basePolicyMismatchCount: 0, mixedPolicyVersions: false },
  };
  assert.equal(new PolicyEvaluator().evaluate({ candidate, replayResult }).conclusion, PolicyEvaluation.ACCEPT_FOR_CANARY);
});

test('Case B: predicted tool recovery risk at 9 percent is REJECT', () => {
  const candidate = validCandidate({ changes: { tool: { pruningConfidenceThreshold: 0.55 } } });
  const replayResult = {
    candidateId: candidate.candidateId, basePolicyVersion: candidate.basePolicyVersion,
    baseline: { estimatedTokens: 100000, estimatedCost: 100, predictedOverflowCount: 1 },
    candidate: { estimatedTokens: 70000, estimatedCost: 80, predictedOverflowCount: 1 },
    delta: { tokenPct: -30, costPct: -20, overflowPct: 0, fallbackPct: 0 },
    risk: { routingDrift: 0, toolRecoveryRisk: 0.09, capabilityViolationCount: 0, unsupportedDecisionCount: 0 },
    dataset: { basePolicyMismatchCount: 0, mixedPolicyVersions: false },
  };
  assert.equal(new PolicyEvaluator().evaluate({ candidate, replayResult }).conclusion, PolicyEvaluation.REJECT);
});

test('Case C: any capability violation hard rejects candidate', () => {
  const candidate = validCandidate({ changes: { backendPriority: { 'no-tools': 1 } } });
  const replayResult = {
    candidateId: candidate.candidateId, basePolicyVersion: candidate.basePolicyVersion,
    baseline: { estimatedTokens: 1000, estimatedCost: 1, predictedOverflowCount: 0 },
    candidate: { estimatedTokens: 900, estimatedCost: 0.9, predictedOverflowCount: 0 },
    delta: { tokenPct: -10, costPct: -10, overflowPct: 0, fallbackPct: 0 },
    risk: { routingDrift: 0.2, toolRecoveryRisk: 0, capabilityViolationCount: 1, unsupportedDecisionCount: 0 },
    dataset: { basePolicyMismatchCount: 0, mixedPolicyVersions: false },
  };
  const evaluation = new PolicyEvaluator().evaluate({ candidate, replayResult });
  assert.equal(evaluation.conclusion, PolicyEvaluation.REJECT);
  assert.ok(evaluation.reasonCodes.includes('CAPABILITY_VIOLATION'));
});

test('token savings with large routing drift requires review rather than activation', () => {
  const candidate = validCandidate({ changes: { backendPriority: { 'slow-tools': 100 } } });
  const replayResult = {
    candidateId: candidate.candidateId, basePolicyVersion: candidate.basePolicyVersion,
    baseline: { estimatedTokens: 100000, estimatedCost: 100, predictedOverflowCount: 2 },
    candidate: { estimatedTokens: 80000, estimatedCost: 90, predictedOverflowCount: 2 },
    delta: { tokenPct: -20, costPct: -10, overflowPct: 0, fallbackPct: 0 },
    risk: { routingDrift: 0.35, toolRecoveryRisk: 0.01, capabilityViolationCount: 0, unsupportedDecisionCount: 0 },
    dataset: { basePolicyMismatchCount: 0, mixedPolicyVersions: false },
  };
  assert.equal(new PolicyEvaluator().evaluate({ candidate, replayResult }).conclusion, PolicyEvaluation.NEEDS_REVIEW);
});

test('candidate that increases predicted overflow is rejected', () => {
  const candidate = validCandidate();
  const replayResult = {
    candidateId: candidate.candidateId, basePolicyVersion: candidate.basePolicyVersion,
    baseline: { estimatedTokens: 100000, estimatedCost: 100, predictedOverflowCount: 4 },
    candidate: { estimatedTokens: 95000, estimatedCost: 95, predictedOverflowCount: 6 },
    delta: { tokenPct: -5, costPct: -5, overflowPct: 50, fallbackPct: 0 },
    risk: { routingDrift: 0, toolRecoveryRisk: 0, capabilityViolationCount: 0, unsupportedDecisionCount: 0 },
    dataset: { basePolicyMismatchCount: 0, mixedPolicyVersions: false },
  };
  assert.equal(new PolicyEvaluator().evaluate({ candidate, replayResult }).conclusion, PolicyEvaluation.REJECT);
});

test('candidate report produces machine JSON and human summary without historical prompt content', () => {
  const candidate = validCandidate();
  const replayResult = {
    candidateId: candidate.candidateId, basePolicyVersion: candidate.basePolicyVersion,
    baseline: { estimatedTokens: 100, estimatedCost: 10, predictedOverflowCount: 1 },
    candidate: { estimatedTokens: 80, estimatedCost: 8, predictedOverflowCount: 0 },
    delta: { tokenPct: -20, costPct: -20, overflowPct: -100, fallbackPct: 0 },
    risk: { routingDrift: 0, toolRecoveryRisk: 0.01, capabilityViolationCount: 0, unsupportedDecisionCount: 0 },
    dataset: { basePolicyMismatchCount: 0, mixedPolicyVersions: false },
  };
  const evaluation = new PolicyEvaluator().evaluate({ candidate, replayResult });
  const report = createPolicyCandidateReport({ candidate, replayResult, evaluation });
  assert.equal(report.json.candidate.candidateId, candidate.candidateId);
  assert.match(report.summary, /Replay prediction:/);
  assert.match(report.summary, /Evaluator:/);
  assert.match(report.summary, /not claimed/);
  assert.equal(report.summary.includes('raw prompt'), false);
});
