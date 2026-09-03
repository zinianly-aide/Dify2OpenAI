import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ExperienceCompiler,
  KnowledgeScope,
  PatternMiner,
  PatternStatus,
  PatternStore,
} from '../packages/dify-core/index.js';

const compiler = new ExperienceCompiler();

function exp(i, overrides = {}) {
  return compiler.compile({
    timestamp: `2026-08-31T01:${String(i).padStart(2, '0')}:00.000Z`,
    clientType: 'dsh',
    taskType: `task-${i}`,
    backendType: 'dify',
    backendId: `backend-${i % 3}`,
    model: `model-${i % 3}`,
    contextAmplification: 1.5,
    checkpointCreated: false,
    toolCountBefore: 10,
    toolCountAfter: 10,
    toolRecoveryTriggered: false,
    migrationOccurred: false,
    fallbackUsed: false,
    routingReasonCodes: [],
    success: true,
    policyVersion: 'v2',
    ...overrides,
  });
}

function find(patterns, key) { return patterns.find((p) => p.semanticKey === key); }

test('repeated context amplification merges into one deterministic pattern', () => {
  const miner = new PatternMiner();
  const pattern = find(miner.mine([exp(1), exp(2), exp(3)]), 'stateful-context-amplification');
  assert.ok(pattern);
  assert.equal(pattern.evidence.observationCount, 3);
  assert.equal(miner.mine([exp(1), exp(2), exp(3)]).filter((p) => p.semanticKey === pattern.semanticKey).length, 1);
});

test('checkpoint success strengthens pattern while failed intervention lowers confidence', () => {
  const miner = new PatternMiner({ minimumStrongEvidence: 6 });
  const supported = find(miner.mine([exp(1, { checkpointCreated: true }), exp(2, { checkpointCreated: true }), exp(3, { checkpointCreated: true })]), 'checkpoint-reduces-backend-context');
  const weakened = find(miner.mine([exp(1, { checkpointCreated: true }), exp(2, { checkpointCreated: true }), exp(3, { checkpointCreated: true, success: false })]), 'checkpoint-reduces-backend-context');
  assert.equal(supported.status, PatternStatus.SUPPORTED);
  assert.ok(weakened.confidence < supported.confidence);
});

test('cross-client evidence increases transferability without storing session identity', () => {
  const miner = new PatternMiner();
  const single = find(miner.mine([exp(1, { clientType: 'dsh', backendId: 'b1', model: 'm1' }), exp(2, { clientType: 'dsh', backendId: 'b1', model: 'm1' }), exp(3, { clientType: 'dsh', backendId: 'b1', model: 'm1' })]), 'stateful-context-amplification');
  const cross = find(miner.mine([exp(1, { clientType: 'dsh', backendId: 'b1', model: 'm1' }), exp(2, { clientType: 'codex', backendType: 'openai-compatible', backendId: 'b2', model: 'm2' }), exp(3, { clientType: 'openai-compatible', backendType: 'local-openai-compatible', backendId: 'b3', model: 'm3' })]), 'stateful-context-amplification');
  assert.ok(cross.transferability > single.transferability);
  assert.equal(JSON.stringify(cross).includes('session'), false);
});

test('generic tool idempotency across DSH+Dify and Codex+OpenAI-compatible supports GENERAL pattern', () => {
  const miner = new PatternMiner({ minimumSupportedEvidence: 2, minimumStrongEvidence: 4 });
  const evidence = [
    exp(1, { clientType: 'dsh', backendType: 'dify', backendId: 'dify-a', routingReasonCodes: ['COMPLETED_TOOL_IDEMPOTENT'] }),
    exp(2, { clientType: 'codex', backendType: 'openai-compatible', backendId: 'oai-a', routingReasonCodes: ['COMPLETED_TOOL_IDEMPOTENT'] }),
  ];
  assert.equal(evidence.every((item) => item.scope === KnowledgeScope.GENERAL), true);
  const pattern = find(miner.mine(evidence), 'completed-tool-idempotency');
  assert.ok(pattern);
  assert.equal(pattern.scope, KnowledgeScope.GENERAL);
  assert.equal(pattern.status, PatternStatus.SUPPORTED);
});

test('Dify conversation_id rotation remains BACKEND_SPECIFIC because rule semantics depend on Dify', () => {
  const experience = exp(1, { backendType: 'dify', backendId: 'dify-a', routingReasonCodes: ['DIFY_CONVERSATION_ID_ROTATION'] });
  assert.equal(experience.scope, KnowledgeScope.GENERAL);
  const pattern = find(new PatternMiner().mine([experience]), 'dify-conversation-id-rotation');
  assert.ok(pattern);
  assert.equal(pattern.scope, KnowledgeScope.BACKEND_SPECIFIC);
});

test('single version-only issue stays VERSION_SPECIFIC', () => {
  const pattern = find(new PatternMiner().mine([exp(1, { checkpointCreated: true, versionSpecific: true })]), 'checkpoint-reduces-backend-context');
  assert.equal(pattern.scope, KnowledgeScope.VERSION_SPECIFIC);
});

test('repeated evidence does not duplicate patterns in PatternStore', () => {
  const pattern = find(new PatternMiner().mine([exp(1), exp(2), exp(3)]), 'stateful-context-amplification');
  const store = new PatternStore();
  store.upsert(pattern); store.upsert(pattern);
  assert.equal(store.listPatterns().length, 1);
});

test('insufficient evidence stays OBSERVED and strong evidence becomes STRONG', () => {
  const miner = new PatternMiner({ minimumSupportedEvidence: 3, minimumStrongEvidence: 5 });
  assert.equal(find(miner.mine([exp(1)]), 'stateful-context-amplification').status, PatternStatus.OBSERVED);
  assert.equal(find(miner.mine([exp(1), exp(2), exp(3), exp(4), exp(5)]), 'stateful-context-amplification').status, PatternStatus.STRONG);
});

test('contradictory checkpoint evidence becomes CONTRADICTED', () => {
  const miner = new PatternMiner({ minimumSupportedEvidence: 3, contradictionRateThreshold: 0.4 });
  const pattern = find(miner.mine([exp(1, { checkpointCreated: true, success: true }), exp(2, { checkpointCreated: true, success: false }), exp(3, { checkpointCreated: true, success: false })]), 'checkpoint-reduces-backend-context');
  assert.equal(pattern.status, PatternStatus.CONTRADICTED);
  assert.equal(pattern.evidence.failureCount, 2);
});

test('promotion threshold emits SKILL_CANDIDATE signal only', () => {
  const miner = new PatternMiner({ minimumStrongEvidence: 6, promotionThreshold: 0.3 });
  const experiences = Array.from({ length: 9 }, (_, i) => exp(i + 1, { clientType: ['dsh', 'codex', 'openai-compatible'][i % 3], backendId: `b${i % 3}`, model: `m${i % 3}` }));
  const pattern = find(miner.mine(experiences), 'stateful-context-amplification');
  assert.equal(pattern.status, PatternStatus.STRONG);
  assert.equal(pattern.promotionSignal, 'SKILL_CANDIDATE');
  assert.equal('skillId' in pattern, false);
});

test('tool recovery, rotation defer, context mismatch, and backend fallback patterns compile deterministically', () => {
  const patterns = new PatternMiner().mine([
    exp(1, { toolCountBefore: 10, toolCountAfter: 3, toolRecoveryTriggered: true }),
    exp(2, { routingReasonCodes: ['ROTATION_DEFERRED_PENDING_TOOL'] }),
    exp(3, { migrationOccurred: true, routingReasonCodes: ['CONTEXT_WINDOW_MISMATCH'] }),
    exp(4, { fallbackUsed: true, routingReasonCodes: ['BACKEND_UNAVAILABLE'] }),
  ]);
  assert.ok(find(patterns, 'tool-pruning-missing-tool-recovery'));
  assert.ok(find(patterns, 'pending-tool-chain-blocks-rotation'));
  assert.ok(find(patterns, 'context-window-mismatch-migration'));
  assert.ok(find(patterns, 'backend-unavailable-fallback'));
});
