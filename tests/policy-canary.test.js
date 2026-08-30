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
  StableCanaryAssignment,
  stableCanaryBucket,
} from '../packages/dify-core/index.js';

const T0 = '2026-08-30T04:00:00.000Z';
const T1 = '2026-08-30T04:10:00.000Z';
const T2 = '2026-08-30T04:20:00.000Z';
const T3 = '2026-08-30T04:30:00.000Z';
const T4 = '2026-08-30T04:40:00.000Z';

function activeV1() {
  return {
    policyVersion: 'v1', basePolicyVersion: null, candidateId: null,
    status: PolicyStatus.ACTIVE, config: {}, createdAt: T0, activatedAt: T0, rollbackOf: null,
    evidence: { source: 'seed' },
  };
}

function candidate(id = 'candidate-v2', base = 'v1', changes = { checkpoint: { backendContextUtilizationThreshold: 0.82 } }) {
  return {
    candidateId: id,
    basePolicyVersion: base,
    changes,
    evidence: { requestCount: 100 },
    hypothesis: 'Candidate has deterministic replay evidence.',
    expectedImpact: { tokens: 'decrease_predicted' },
    confidence: 'medium',
    createdAt: T1,
  };
}

function replayFor(c) {
  return {
    candidateId: c.candidateId,
    basePolicyVersion: c.basePolicyVersion,
    dataset: { datasetId: 'dataset-1', contentHash: 'abc' },
    risk: { capabilityViolationCount: 0, unsupportedDecisionCount: 0 },
  };
}

function accepted() { return { conclusion: PolicyEvaluation.ACCEPT_FOR_CANARY, reasonCodes: ['HARD_GUARDRAILS_PASSED'] }; }
function registryWithV2() {
  const registry = new PolicyRegistry({ policies: [activeV1()] });
  const c = candidate();
  registry.registerReplayPassed({ candidate: c, evaluation: accepted(), replayResult: replayFor(c), createdAt: T1, policyVersion: 'v2' });
  return registry;
}

function monitor(minimumRequests = 2) {
  return new GuardrailMonitor({
    stages: {
      [PolicyStatus.CANARY_5]: { minimumRequests, minimumObservationWindowMs: 0 },
      [PolicyStatus.CANARY_20]: { minimumRequests, minimumObservationWindowMs: 0 },
      [PolicyStatus.CANARY_50]: { minimumRequests, minimumObservationWindowMs: 0 },
    },
  });
}

function recordPair(m, policyVersion, timestamp, overrides = {}) {
  m.record({
    timestamp, policyVersion, success: true, backendPromptTokens: 100, completionTokens: 10,
    estimatedCost: 1, toolRequest: true, toolSuccess: true, toolRecoveryTriggered: false,
    fallbackUsed: false, latencyMs: 100, firstTokenLatencyMs: 20,
    ...overrides,
  });
}

function healthyStageTraffic(m, start, candidateVersion = 'v2', baselineVersion = 'v1') {
  recordPair(m, baselineVersion, start, { backendPromptTokens: 100, estimatedCost: 1 });
  recordPair(m, baselineVersion, start, { backendPromptTokens: 100, estimatedCost: 1 });
  recordPair(m, candidateVersion, start, { backendPromptTokens: 82, estimatedCost: 0.88 });
  recordPair(m, candidateVersion, start, { backendPromptTokens: 82, estimatedCost: 0.88 });
}

test('only ACCEPT_FOR_CANARY replay can register a canary-eligible policy', () => {
  const c = candidate();
  const rejectedRegistry = new PolicyRegistry({ policies: [activeV1()] });
  assert.throws(() => rejectedRegistry.registerReplayPassed({
    candidate: c, evaluation: { conclusion: PolicyEvaluation.REJECT }, replayResult: replayFor(c), createdAt: T1,
  }), /CANARY_REQUIRES_ACCEPT_FOR_CANARY/);
  const reviewRegistry = new PolicyRegistry({ policies: [activeV1()] });
  assert.throws(() => reviewRegistry.registerReplayPassed({
    candidate: c, evaluation: { conclusion: PolicyEvaluation.NEEDS_REVIEW }, replayResult: replayFor(c), createdAt: T1,
  }), /CANARY_REQUIRES_ACCEPT_FOR_CANARY/);
  const registry = new PolicyRegistry({ policies: [activeV1()] });
  const v2 = registry.registerReplayPassed({ candidate: c, evaluation: accepted(), replayResult: replayFor(c), createdAt: T1, policyVersion: 'v2' });
  assert.equal(v2.status, PolicyStatus.REPLAY_PASSED);
});

test('canary creation revalidates capability and base policy version', () => {
  const c = candidate();
  const registry = new PolicyRegistry({ policies: [activeV1()] });
  assert.throws(() => registry.registerReplayPassed({
    candidate: c, evaluation: accepted(), replayResult: { ...replayFor(c), risk: { capabilityViolationCount: 1, unsupportedDecisionCount: 0 } }, createdAt: T1,
  }), /CANARY_CAPABILITY_VALIDATION_FAILED/);
  const wrongBase = candidate('candidate-wrong', 'v0');
  assert.throws(() => registry.registerReplayPassed({ candidate: wrongBase, evaluation: accepted(), replayResult: replayFor(wrongBase), createdAt: T1 }), /CANARY_BASE_POLICY_VERSION_MISMATCH/);
});

test('same session receives stable deterministic bucket and 5 percent assignment never drifts', () => {
  const registry = registryWithV2();
  const promotion = new PromotionController({ registry, monitor: monitor() });
  promotion.startCanary('v2', { timestamp: T2 });
  const assigner = new StableCanaryAssignment({ registry });
  let session = null;
  for (let i = 0; i < 10000; i += 1) {
    const value = `session-${i}`;
    if (stableCanaryBucket(value, 'v2') < 5) { session = value; break; }
  }
  assert.ok(session);
  const bucketA = stableCanaryBucket(session, 'v2');
  const bucketB = stableCanaryBucket(session, 'v2');
  assert.equal(bucketA, bucketB);
  assert.ok(bucketA >= 0 && bucketA < 5);
  const first = assigner.select({ sessionId: session });
  const second = assigner.select({ sessionId: session });
  assert.deepEqual(first, second);
  assert.equal(first.selectedPolicyVersion, 'v2');
  assert.equal(first.policyAssignment, 'CANARY');
  assert.equal(first.canaryStage, PolicyStatus.CANARY_5);
});

test('sample insufficient keeps current canary stage', () => {
  const registry = registryWithV2();
  const m = monitor(3);
  const controller = new PromotionController({ registry, monitor: m });
  controller.startCanary('v2', { timestamp: T2 });
  recordPair(m, 'v1', T2);
  recordPair(m, 'v2', T2, { backendPromptTokens: 80, estimatedCost: 0.8 });
  const result = controller.evaluateAndPromote('v2', { observationEnd: T3 });
  assert.equal(result.status, GuardrailStatus.INSUFFICIENT_CANARY_EVIDENCE);
  assert.equal(registry.get('v2').status, PolicyStatus.CANARY_5);
});

test('healthy CANARY_5 promotes only to CANARY_20', () => {
  const registry = registryWithV2();
  const m = monitor();
  const controller = new PromotionController({ registry, monitor: m });
  controller.startCanary('v2', { timestamp: T2 });
  healthyStageTraffic(m, T2);
  const result = controller.evaluateAndPromote('v2', { observationEnd: T3 });
  assert.equal(result.promotion.targetStage, PolicyStatus.CANARY_20);
  assert.equal(registry.get('v2').status, PolicyStatus.CANARY_20);
});

test('healthy CANARY_20 promotes only to CANARY_50', () => {
  const registry = registryWithV2();
  const m = monitor();
  const controller = new PromotionController({ registry, monitor: m });
  controller.startCanary('v2', { timestamp: T1 });
  registry.transition('v2', PolicyStatus.CANARY_20, { timestamp: T2, evaluationSnapshotId: 'manual-seed', reasonCodes: ['TEST'] });
  healthyStageTraffic(m, T2);
  const result = controller.evaluateAndPromote('v2', { observationEnd: T3 });
  assert.equal(result.promotion.targetStage, PolicyStatus.CANARY_50);
});

test('healthy CANARY_50 atomically activates candidate and preserves old ACTIVE as SUPERSEDED', () => {
  const registry = registryWithV2();
  const m = monitor();
  const controller = new PromotionController({ registry, monitor: m });
  controller.startCanary('v2', { timestamp: T1 });
  registry.transition('v2', PolicyStatus.CANARY_20, { timestamp: T2, evaluationSnapshotId: 'seed-1', reasonCodes: ['TEST'] });
  registry.transition('v2', PolicyStatus.CANARY_50, { timestamp: T3, evaluationSnapshotId: 'seed-2', reasonCodes: ['TEST'] });
  healthyStageTraffic(m, T3);
  const result = controller.evaluateAndPromote('v2', { observationEnd: T4 });
  assert.equal(result.promotion.targetStage, PolicyStatus.ACTIVE);
  assert.equal(registry.getActive().policyVersion, 'v2');
  assert.equal(registry.get('v1').status, PolicyStatus.SUPERSEDED);
  assert.ok(registry.get('v1'));
  assert.equal(registry.list().filter((p) => p.status === PolicyStatus.ACTIVE).length, 1);
});

test('capability violation hard guardrail auto-rolls back canary', () => {
  const registry = registryWithV2();
  const m = monitor();
  const controller = new PromotionController({ registry, monitor: m });
  controller.startCanary('v2', { timestamp: T2 });
  recordPair(m, 'v1', T2); recordPair(m, 'v1', T2);
  recordPair(m, 'v2', T2, { backendPromptTokens: 80, estimatedCost: 0.8, capabilityViolationCount: 1 });
  recordPair(m, 'v2', T2, { backendPromptTokens: 80, estimatedCost: 0.8 });
  const result = controller.evaluateAndPromote('v2', { observationEnd: T3 });
  assert.equal(result.status, GuardrailStatus.AUTO_ROLLBACK);
  assert.equal(registry.get('v2').status, PolicyStatus.ROLLED_BACK);
  assert.equal(registry.getActive().policyVersion, 'v1');
});

test('error rate hard regression auto-rolls back', () => {
  const registry = registryWithV2();
  const m = monitor();
  const controller = new PromotionController({ registry, monitor: m });
  controller.startCanary('v2', { timestamp: T2 });
  recordPair(m, 'v1', T2); recordPair(m, 'v1', T2);
  recordPair(m, 'v2', T2, { success: false, backendPromptTokens: 80, estimatedCost: 0.8 });
  recordPair(m, 'v2', T2, { backendPromptTokens: 80, estimatedCost: 0.8 });
  assert.equal(controller.evaluateAndPromote('v2', { observationEnd: T3 }).status, GuardrailStatus.AUTO_ROLLBACK);
});

test('tool success regression above hard threshold auto-rolls back', () => {
  const registry = registryWithV2();
  const m = monitor();
  const controller = new PromotionController({ registry, monitor: m });
  controller.startCanary('v2', { timestamp: T2 });
  recordPair(m, 'v1', T2, { toolSuccessRate: 1 }); recordPair(m, 'v1', T2, { toolSuccessRate: 1 });
  recordPair(m, 'v2', T2, { backendPromptTokens: 75, estimatedCost: 0.75, toolSuccessRate: 0.94 });
  recordPair(m, 'v2', T2, { backendPromptTokens: 75, estimatedCost: 0.75, toolSuccessRate: 0.94 });
  assert.equal(controller.evaluateAndPromote('v2', { observationEnd: T3 }).status, GuardrailStatus.AUTO_ROLLBACK);
});

test('fallback spike auto-rolls back', () => {
  const registry = registryWithV2();
  const m = monitor();
  const controller = new PromotionController({ registry, monitor: m });
  controller.startCanary('v2', { timestamp: T2 });
  for (let i = 0; i < 10; i += 1) recordPair(m, 'v1', T2);
  for (let i = 0; i < 10; i += 1) recordPair(m, 'v2', T2, { backendPromptTokens: 80, estimatedCost: 0.8, fallbackUsed: i < 2 });
  assert.equal(controller.evaluateAndPromote('v2', { observationEnd: T3 }).status, GuardrailStatus.AUTO_ROLLBACK);
});

test('soft regression holds for review without promotion', () => {
  const registry = registryWithV2();
  const m = monitor(100);
  const controller = new PromotionController({ registry, monitor: m });
  controller.startCanary('v2', { timestamp: T2 });
  for (let i = 0; i < 100; i += 1) recordPair(m, 'v1', T2);
  for (let i = 0; i < 100; i += 1) recordPair(m, 'v2', T2, { success: i >= 2, backendPromptTokens: 80, estimatedCost: 0.8 });
  const result = controller.evaluateAndPromote('v2', { observationEnd: T3 });
  assert.equal(result.status, GuardrailStatus.HOLD_FOR_REVIEW);
  assert.equal(registry.get('v2').status, PolicyStatus.CANARY_5);
});

test('rollback removes candidate traffic and selection returns stable ACTIVE', () => {
  const registry = registryWithV2();
  const m = monitor();
  const control = new PolicyControlPlane({ registry, monitor: m });
  control.promotion.startCanary('v2', { timestamp: T2 });
  let canarySession;
  for (let i = 0; i < 10000; i += 1) if (stableCanaryBucket(`s-${i}`, 'v2') < 5) { canarySession = `s-${i}`; break; }
  assert.equal(control.selectPolicy({ sessionId: canarySession }).selectedPolicyVersion, 'v2');
  recordPair(m, 'v1', T2); recordPair(m, 'v1', T2);
  recordPair(m, 'v2', T2, { success: false }); recordPair(m, 'v2', T2, { success: false });
  control.promotion.evaluateAndPromote('v2', { observationEnd: T3 });
  const selected = control.selectPolicy({ sessionId: canarySession });
  assert.equal(selected.selectedPolicyVersion, 'v1');
  assert.equal(selected.policyAssignment, 'ACTIVE_BASELINE');
});

test('registry selection failure fails open to last stable ACTIVE', () => {
  const registry = new PolicyRegistry({ policies: [activeV1()] });
  const control = new PolicyControlPlane({ registry, monitor: monitor() });
  registry.getActive = () => { throw new Error('REGISTRY_CORRUPTION'); };
  const selected = control.selectPolicy({ sessionId: 'session-stable' });
  assert.equal(selected.selectedPolicyVersion, 'v1');
  assert.equal(selected.policyAssignment, 'STABLE_ACTIVE_FAIL_OPEN');
});

test('manual freeze prevents automatic promotion and all controls are audited', () => {
  const registry = registryWithV2();
  const m = monitor();
  const controller = new PromotionController({ registry, monitor: m });
  controller.startCanary('v2', { timestamp: T2 });
  healthyStageTraffic(m, T2);
  registry.freezeEvolution({ timestamp: T2 });
  const held = controller.evaluateAndPromote('v2', { observationEnd: T3 });
  assert.equal(held.status, GuardrailStatus.HOLD_FOR_REVIEW);
  assert.equal(registry.get('v2').status, PolicyStatus.CANARY_5);
  registry.resumeEvolution({ timestamp: T3 });
  registry.disableAutoPromotion({ timestamp: T3 });
  registry.enableAutoPromotion({ timestamp: T3 });
  registry.pinActivePolicy('v1', { timestamp: T3 });
  registry.clearActivePin({ timestamp: T3 });
  assert.ok(registry.getAuditLog().some((entry) => entry.action === 'FREEZE_EVOLUTION'));
  assert.ok(registry.getAuditLog().some((entry) => entry.action === 'PIN_ACTIVE_POLICY'));
});

test('manual rollback can restore preserved old ACTIVE version', () => {
  const registry = registryWithV2();
  const m = monitor();
  const controller = new PromotionController({ registry, monitor: m });
  controller.startCanary('v2', { timestamp: T1 });
  controller.manualPromote('v2', { timestamp: T2 });
  controller.manualPromote('v2', { timestamp: T3 });
  controller.manualPromote('v2', { timestamp: T4 });
  assert.equal(registry.getActive().policyVersion, 'v2');
  assert.equal(registry.get('v1').status, PolicyStatus.SUPERSEDED);
  controller.manualRollback('v2', 'v1', { timestamp: '2026-08-30T04:50:00.000Z' });
  assert.equal(registry.getActive().policyVersion, 'v1');
  assert.equal(registry.get('v2').status, PolicyStatus.ROLLED_BACK);
});

test('promotion transition cannot skip stages', () => {
  const registry = registryWithV2();
  assert.throws(() => registry.transition('v2', PolicyStatus.ACTIVE, { timestamp: T2 }), /POLICY_STAGE_SKIP_FORBIDDEN/);
});

test('guardrail snapshot is immutable and content-addressed', () => {
  const m = monitor();
  healthyStageTraffic(m, T2);
  const a = m.evaluate({ policyVersion: 'v2', baselinePolicyVersion: 'v1', stage: PolicyStatus.CANARY_5, observationStart: T2, observationEnd: T3 });
  const b = m.evaluate({ policyVersion: 'v2', baselinePolicyVersion: 'v1', stage: PolicyStatus.CANARY_5, observationStart: T2, observationEnd: T3 });
  assert.deepEqual(a, b);
  assert.equal(a.snapshotId, b.snapshotId);
  assert.equal(Object.isFrozen(a), true);
  assert.equal(a.guardrailResults.status, GuardrailStatus.ELIGIBLE_FOR_PROMOTION);
});
