import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GuardrailMonitor,
  GuardrailStatus,
  PolicyControlPlane,
  PolicyEvaluation,
  PolicyRegistry,
  PolicyStatus,
  PromotionController,
  stableCanaryBucket,
} from '../packages/dify-core/index.js';
import {
  resetPolicyRuntimeForTests,
} from '../lib/policy-runtime.js';
import { selectPolicyForRequest } from '../lib/policy-request.js';

const T0 = '2026-08-30T04:00:00.000Z';
const T1 = '2026-08-30T04:10:00.000Z';
const T2 = '2026-08-30T04:20:00.000Z';
const T3 = '2026-08-30T04:30:00.000Z';
const T4 = '2026-08-30T04:40:00.000Z';
const T5 = '2026-08-30T04:50:00.000Z';
const T6 = '2026-08-30T05:00:00.000Z';

function active(version = 'v1', createdAt = T0, config = {}) {
  return {
    policyVersion: version,
    basePolicyVersion: null,
    candidateId: null,
    status: PolicyStatus.ACTIVE,
    config,
    createdAt,
    activatedAt: createdAt,
    rollbackOf: null,
    evidence: { source: 'seed' },
  };
}

function candidate(id, basePolicyVersion, changes = { checkpoint: { backendContextUtilizationThreshold: 0.82 } }, createdAt = T1) {
  return {
    candidateId: id,
    basePolicyVersion,
    changes,
    evidence: { requestCount: 1000 },
    hypothesis: 'Deterministic replay supports a canary.',
    expectedImpact: { tokens: 'decrease_predicted' },
    confidence: 'high',
    createdAt,
  };
}

function replayFor(c) {
  return {
    candidateId: c.candidateId,
    basePolicyVersion: c.basePolicyVersion,
    dataset: { datasetId: `dataset-${c.candidateId}`, contentHash: `hash-${c.candidateId}` },
    risk: { capabilityViolationCount: 0, unsupportedDecisionCount: 0 },
  };
}

const ACCEPTED = Object.freeze({
  conclusion: PolicyEvaluation.ACCEPT_FOR_CANARY,
  reasonCodes: Object.freeze(['HARD_GUARDRAILS_PASSED', 'SOFT_GUARDRAILS_PASSED']),
});

function monitor(minimumRequests = 2) {
  return new GuardrailMonitor({
    stages: {
      [PolicyStatus.CANARY_5]: { minimumRequests, minimumObservationWindowMs: 0 },
      [PolicyStatus.CANARY_20]: { minimumRequests, minimumObservationWindowMs: 0 },
      [PolicyStatus.CANARY_50]: { minimumRequests, minimumObservationWindowMs: 0 },
    },
  });
}

function record(m, policyVersion, timestamp, overrides = {}) {
  return m.record({
    timestamp,
    policyVersion,
    success: true,
    backendPromptTokens: 100,
    completionTokens: 10,
    estimatedCost: 1,
    contextOverflow: false,
    forcedCompression: false,
    checkpointCreated: false,
    toolRequest: true,
    toolSuccessRate: 1,
    toolRecoveryTriggered: false,
    fallbackUsed: false,
    latencyMs: 100,
    firstTokenLatencyMs: 20,
    capabilityViolationCount: 0,
    unsupportedDecisionCount: 0,
    routingDrift: false,
    ...overrides,
  });
}

function healthyPair(m, baselineVersion, candidateVersion, timestamp, count = 2) {
  for (let i = 0; i < count; i += 1) {
    record(m, baselineVersion, timestamp, { backendPromptTokens: 100, estimatedCost: 1 });
    record(m, candidateVersion, timestamp, { backendPromptTokens: 82, estimatedCost: 0.88 });
  }
}

function findSession(version, predicate) {
  for (let i = 0; i < 50000; i += 1) {
    const session = `session-${i}`;
    if (predicate(stableCanaryBucket(session, version))) return session;
  }
  throw new Error('DETERMINISTIC_CANARY_SESSION_NOT_FOUND');
}

test('final E2E: v1 ACTIVE -> v2 full promotion -> v3 hard regression rollback -> all traffic v2', () => {
  const registry = new PolicyRegistry({ policies: [active('v1')] });
  const m = monitor();
  const control = new PolicyControlPlane({ registry, monitor: m });

  const c2 = candidate('candidate-v2', 'v1');
  registry.registerReplayPassed({ candidate: c2, evaluation: ACCEPTED, replayResult: replayFor(c2), policyVersion: 'v2', createdAt: T1 });
  control.promotion.startCanary('v2', { timestamp: T1 });

  healthyPair(m, 'v1', 'v2', T1);
  assert.equal(control.promotion.evaluateAndPromote('v2', { observationEnd: T2 }).promotion.targetStage, PolicyStatus.CANARY_20);
  healthyPair(m, 'v1', 'v2', T2);
  assert.equal(control.promotion.evaluateAndPromote('v2', { observationEnd: T3 }).promotion.targetStage, PolicyStatus.CANARY_50);
  healthyPair(m, 'v1', 'v2', T3);
  assert.equal(control.promotion.evaluateAndPromote('v2', { observationEnd: T4 }).promotion.targetStage, PolicyStatus.ACTIVE);
  assert.equal(registry.getActive().policyVersion, 'v2');
  assert.equal(registry.list().filter((p) => p.status === PolicyStatus.ACTIVE).length, 1);
  assert.equal(registry.get('v1').status, PolicyStatus.SUPERSEDED);

  const c3 = candidate('candidate-v3', 'v2', { tool: { pruningConfidenceThreshold: 0.60 } }, T4);
  registry.registerReplayPassed({ candidate: c3, evaluation: ACCEPTED, replayResult: replayFor(c3), policyVersion: 'v3', createdAt: T4 });
  control.promotion.startCanary('v3', { timestamp: T4 });
  healthyPair(m, 'v2', 'v3', T4);
  record(m, 'v3', T4, { backendPromptTokens: 75, estimatedCost: 0.75, toolSuccessRate: 0.80 });
  const rollback = control.promotion.evaluateAndPromote('v3', { observationEnd: T5 });
  assert.equal(rollback.status, GuardrailStatus.AUTO_ROLLBACK);
  assert.equal(registry.get('v3').status, PolicyStatus.ROLLED_BACK);
  assert.equal(rollback.rollback.rollbackTargetPolicy, 'v2');
  assert.equal(registry.getActive().policyVersion, 'v2');

  for (let i = 0; i < 500; i += 1) {
    const selected = control.selectPolicy({ sessionId: `production-${i}` });
    assert.equal(selected.selectedPolicyVersion, 'v2');
    assert.notEqual(selected.selectedPolicyVersion, 'v3');
  }
  assert.ok(registry.get('v1'));
  assert.ok(registry.get('v2'));
  assert.ok(registry.get('v3'));
});

test('Case A exact metrics: token -18%, cost -12%, error +0.1%, tool success -0.05%, fallback unchanged promotes 5 -> 20', () => {
  const registry = new PolicyRegistry({ policies: [active('v1')] });
  const c2 = candidate('candidate-case-a', 'v1');
  registry.registerReplayPassed({ candidate: c2, evaluation: ACCEPTED, replayResult: replayFor(c2), policyVersion: 'v2', createdAt: T1 });
  const m = monitor(1000);
  const controller = new PromotionController({ registry, monitor: m });
  controller.startCanary('v2', { timestamp: T1 });

  for (let i = 0; i < 1000; i += 1) {
    record(m, 'v1', T1, { backendPromptTokens: 100, estimatedCost: 1, toolSuccessRate: 1, fallbackUsed: false });
    record(m, 'v2', T1, {
      backendPromptTokens: 82,
      estimatedCost: 0.88,
      success: i !== 0,
      toolSuccessRate: 0.9995,
      fallbackUsed: false,
    });
  }

  const result = controller.evaluateAndPromote('v2', { observationEnd: T2 });
  assert.equal(result.status, GuardrailStatus.ELIGIBLE_FOR_PROMOTION);
  assert.equal(result.snapshot.candidateMetrics.requestCount, 1000);
  assert.equal(result.snapshot.candidateMetrics.errorRate - result.snapshot.baselineMetrics.errorRate, 0.001);
  assert.ok(Math.abs((result.snapshot.candidateMetrics.toolSuccessRate - result.snapshot.baselineMetrics.toolSuccessRate) - (-0.0005)) < 1e-12);
  assert.equal(result.snapshot.candidateMetrics.fallbackRate, result.snapshot.baselineMetrics.fallbackRate);
  assert.equal(result.snapshot.candidateMetrics.backendPromptTokens / result.snapshot.baselineMetrics.backendPromptTokens, 0.82);
  assert.equal(result.snapshot.candidateMetrics.estimatedCost / result.snapshot.baselineMetrics.estimatedCost, 0.88);
  assert.equal(result.snapshot.guardrailResults.promotionEligible, true);
  assert.equal(result.promotion.targetStage, PolicyStatus.CANARY_20);
});

test('Case D: guardrail evaluator exception blocks canary assignment and fails open to stable ACTIVE', () => {
  const registry = new PolicyRegistry({ policies: [active('v1')] });
  const c2 = candidate('candidate-evaluator-failure', 'v1');
  registry.registerReplayPassed({ candidate: c2, evaluation: ACCEPTED, replayResult: replayFor(c2), policyVersion: 'v2', createdAt: T1 });
  const throwingMonitor = { evaluate() { throw new Error('EVALUATOR_BOOM'); } };
  const control = new PolicyControlPlane({ registry, monitor: throwingMonitor });
  control.promotion.startCanary('v2', { timestamp: T1 });
  const canarySession = findSession('v2', (bucket) => bucket < 5);
  assert.equal(control.selectPolicy({ sessionId: canarySession }).selectedPolicyVersion, 'v2');

  const result = control.promotion.evaluateAndPromote('v2', { observationEnd: T2 });
  assert.equal(result.status, GuardrailStatus.EVALUATION_FAILED);
  assert.ok(result.reasonCodes.includes('GUARDRAIL_EVALUATION_FAILED'));
  assert.equal(registry.get('v2').status, PolicyStatus.CANARY_5);

  const selected = control.selectPolicy({ sessionId: canarySession });
  assert.equal(selected.selectedPolicyVersion, 'v1');
  assert.equal(selected.policyAssignment, 'STABLE_ACTIVE_FAIL_OPEN');
  assert.match(selected.selectionFallbackReason, /GUARDRAIL_EVALUATION_FAILED/);
});

test('stable bucket and assignment are deterministic across repeated rounds', () => {
  const registry = new PolicyRegistry({ policies: [active('v1')] });
  const c2 = candidate('candidate-stable', 'v1');
  registry.registerReplayPassed({ candidate: c2, evaluation: ACCEPTED, replayResult: replayFor(c2), policyVersion: 'v2', createdAt: T1 });
  const control = new PolicyControlPlane({ registry, monitor: monitor() });
  control.promotion.startCanary('v2', { timestamp: T1 });
  const canarySession = findSession('v2', (bucket) => bucket < 5);
  const baselineSession = findSession('v2', (bucket) => bucket >= 5);
  const canaryBucket = stableCanaryBucket(canarySession, 'v2');
  const baselineBucket = stableCanaryBucket(baselineSession, 'v2');
  for (let i = 0; i < 100; i += 1) {
    assert.equal(stableCanaryBucket(canarySession, 'v2'), canaryBucket);
    assert.equal(stableCanaryBucket(baselineSession, 'v2'), baselineBucket);
    assert.equal(control.selectPolicy({ sessionId: canarySession }).selectedPolicyVersion, 'v2');
    assert.equal(control.selectPolicy({ sessionId: baselineSession }).selectedPolicyVersion, 'v1');
  }
});

test('canary snapshot is immutable and content-addressed deterministically', () => {
  const m = monitor();
  healthyPair(m, 'v1', 'v2', T1);
  const first = m.evaluate({ policyVersion: 'v2', baselinePolicyVersion: 'v1', stage: PolicyStatus.CANARY_5, observationStart: T1, observationEnd: T2 });
  const second = m.evaluate({ policyVersion: 'v2', baselinePolicyVersion: 'v1', stage: PolicyStatus.CANARY_5, observationStart: T1, observationEnd: T2 });
  assert.deepEqual(first, second);
  assert.equal(first.snapshotId, second.snapshotId);
  assert.equal(first.contentHash, second.contentHash);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.candidateMetrics), true);

  record(m, 'v2', T1, { backendPromptTokens: 70, estimatedCost: 0.70 });
  const changed = m.evaluate({ policyVersion: 'v2', baselinePolicyVersion: 'v1', stage: PolicyStatus.CANARY_5, observationStart: T1, observationEnd: T2 });
  assert.notEqual(changed.snapshotId, first.snapshotId);
  assert.notEqual(changed.contentHash, first.contentHash);
});

test('minimum evidence gating keeps healthy candidate in current stage without rollback', () => {
  const registry = new PolicyRegistry({ policies: [active('v1')] });
  const c2 = candidate('candidate-insufficient', 'v1');
  registry.registerReplayPassed({ candidate: c2, evaluation: ACCEPTED, replayResult: replayFor(c2), policyVersion: 'v2', createdAt: T1 });
  const m = monitor(10);
  const controller = new PromotionController({ registry, monitor: m });
  controller.startCanary('v2', { timestamp: T1 });
  healthyPair(m, 'v1', 'v2', T1, 3);
  const result = controller.evaluateAndPromote('v2', { observationEnd: T2 });
  assert.equal(result.status, GuardrailStatus.INSUFFICIENT_CANARY_EVIDENCE);
  assert.equal(result.snapshot.guardrailResults.promotionEligible, false);
  assert.equal(registry.get('v2').status, PolicyStatus.CANARY_5);
  assert.equal(registry.getActive().policyVersion, 'v1');
});

test('failed ACTIVE promotion attempt leaves exactly one stable ACTIVE and preserves old policy', () => {
  const registry = new PolicyRegistry({ policies: [active('v1')] });
  const c2 = candidate('candidate-atomic', 'v1');
  registry.registerReplayPassed({ candidate: c2, evaluation: ACCEPTED, replayResult: replayFor(c2), policyVersion: 'v2', createdAt: T1 });
  registry.transition('v2', PolicyStatus.CANARY_5, { timestamp: T1, evaluationSnapshotId: 's1', reasonCodes: ['TEST'] });
  registry.transition('v2', PolicyStatus.CANARY_20, { timestamp: T2, evaluationSnapshotId: 's2', reasonCodes: ['TEST'] });
  registry.transition('v2', PolicyStatus.CANARY_50, { timestamp: T3, evaluationSnapshotId: 's3', reasonCodes: ['TEST'] });

  const originalValidate = registry.validatePolicy.bind(registry);
  registry.validatePolicy = () => ({ valid: false, errors: ['INJECTED_PROMOTION_FAILURE'] });
  assert.throws(() => registry.transition('v2', PolicyStatus.ACTIVE, { timestamp: T4, evaluationSnapshotId: 's4', reasonCodes: ['TEST'] }), /POLICY_CONFIG_INVALID/);
  registry.validatePolicy = originalValidate;
  assert.equal(registry.getActive().policyVersion, 'v1');
  assert.equal(registry.get('v2').status, PolicyStatus.CANARY_50);
  assert.equal(registry.list().filter((p) => p.status === PolicyStatus.ACTIVE).length, 1);
  assert.ok(registry.get('v1'));
});

test('policy runtime reload failure fails open to cached stable ACTIVE with safety reason', () => {
  resetPolicyRuntimeForTests();
  const goodEnv = { GATEWAY_POLICIES_JSON: JSON.stringify([active('v1')]) };
  const req = { headers: { 'x-session-id': 'runtime-session' }, body: {} };
  const res = { locals: {} };
  const first = selectPolicyForRequest(req, res, goodEnv);
  assert.equal(first.selectedPolicyVersion, 'v1');

  const badEnv = { GATEWAY_POLICIES_JSON: '{not-json' };
  const fallbackRes = { locals: {} };
  const fallback = selectPolicyForRequest(req, fallbackRes, badEnv);
  assert.equal(fallback.selectedPolicyVersion, 'v1');
  assert.equal(fallback.policyAssignment, 'STABLE_ACTIVE_FAIL_OPEN');
  assert.match(fallback.selectionFallbackReason, /Unexpected token|JSON|position/i);
  assert.ok(fallbackRes.locals.gatewayGuardrail.reasonCodes.includes('POLICY_RUNTIME_FAIL_OPEN_TO_STABLE_ACTIVE'));
  resetPolicyRuntimeForTests();
});
