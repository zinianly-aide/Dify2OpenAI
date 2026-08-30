import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BackendContextMode,
  BackendHealthState,
  BackendHealthStore,
  BackendProviderType,
  BackendRegistry,
  CheckpointManager,
  ContextMigrationPlanner,
  DeterministicBackendRouter,
  MemoryConversationStore,
  ToolExecutionLedger,
  assertNoCrossBackendConversationReuse,
  isFallbackEligible,
} from '../packages/dify-core/index.js';

function makeRegistry() {
  return new BackendRegistry([
    {
      backendId: 'dify-a', providerType: BackendProviderType.DIFY, baseUrl: 'http://dify-a/v1', model: 'a', enabled: true,
      maxContextWindow: 32000, supportsTools: true, supportsVision: false, supportsStreaming: true, supportsReasoning: false,
      statefulContext: true, costTier: 'medium', priority: 20,
    },
    {
      backendId: 'dify-b', providerType: BackendProviderType.DIFY, baseUrl: 'http://dify-b/v1', model: 'b', enabled: true,
      maxContextWindow: 128000, supportsTools: true, supportsVision: true, supportsStreaming: true, supportsReasoning: true,
      statefulContext: true, costTier: 'high', priority: 30,
    },
    {
      backendId: 'cheap', providerType: BackendProviderType.OPENAI_COMPATIBLE, baseUrl: 'http://cheap/v1', model: 'cheap', enabled: true,
      maxContextWindow: 16000, supportsTools: false, supportsVision: false, supportsStreaming: true, supportsReasoning: false,
      statefulContext: false, costTier: 'low', priority: 10,
    },
    {
      backendId: 'local', providerType: BackendProviderType.LOCAL_OPENAI_COMPATIBLE, baseUrl: 'http://127.0.0.1:8080/v1', model: 'local', enabled: true,
      maxContextWindow: 64000, supportsTools: true, supportsVision: false, supportsStreaming: true, supportsReasoning: false,
      statefulContext: false, costTier: 'low', priority: 15,
    },
  ]);
}

function routerWithHealth() {
  const registry = makeRegistry();
  const health = new BackendHealthStore();
  return { registry, health, router: new DeterministicBackendRouter({ registry, healthStore: health }) };
}

test('healthy compatible backend keeps session affinity', () => {
  const { router } = routerWithHealth();
  const decision = router.decide({ currentBackendId: 'dify-a', estimatedTokens: 4000, requiresTools: true });
  assert.equal(decision.backendId, 'dify-a');
  assert.equal(decision.migrationRequired, false);
  assert.ok(decision.reasonCodes.includes('SESSION_AFFINITY'));
});

test('tool request filters non-tool backend', () => {
  const { router } = routerWithHealth();
  const decision = router.decide({ currentBackendId: 'cheap', estimatedTokens: 4000, requiresTools: true, toolCount: 2 });
  assert.notEqual(decision.backendId, 'cheap');
  assert.ok(decision.reasonCodes.includes('CAPABILITY_MISMATCH'));
  assert.ok(decision.reasonCodes.includes('CAPABILITY_TOOLS_REQUIRED'));
});

test('vision request filters non-vision backend', () => {
  const { router } = routerWithHealth();
  const decision = router.decide({ currentBackendId: 'dify-a', estimatedTokens: 4000, hasImages: true });
  assert.equal(decision.backendId, 'dify-b');
  assert.ok(decision.reasonCodes.includes('CAPABILITY_VISION_REQUIRED'));
});

test('context limit forces larger backend deterministically', () => {
  const { router } = routerWithHealth();
  const decision = router.decide({ currentBackendId: 'dify-a', estimatedTokens: 90000, requiresTools: true });
  assert.equal(decision.backendId, 'dify-b');
  assert.equal(decision.migrationRequired, true);
  assert.ok(decision.reasonCodes.includes('CONTEXT_LIMIT'));
});

test('unavailable backend triggers deterministic fallback selection', () => {
  const { router, health } = routerWithHealth();
  health.setSnapshot('dify-a', { state: BackendHealthState.UNAVAILABLE, recentFailureRate: 1, consecutiveFailures: 3 });
  const decision = router.decide({ currentBackendId: 'dify-a', estimatedTokens: 4000, requiresTools: true });
  assert.equal(decision.backendId, 'local');
  assert.ok(decision.reasonCodes.includes('BACKEND_UNAVAILABLE'));
  assert.ok(decision.fallbackChain.includes('dify-b'));
});

test('simple small request can choose low-cost backend with explicit stable ordering', () => {
  const { router } = routerWithHealth();
  const decision = router.decide({ taskType: 'simple', estimatedTokens: 1000, contextUtilization: 0.1, requiresTools: false, hasImages: false });
  assert.equal(decision.backendId, 'cheap');
  assert.ok(decision.reasonCodes.includes('LOW_COST_SIMPLE_TASK'));
});

test('backend health is deterministic', () => {
  const health = new BackendHealthStore({ minimumSamples: 4, unavailableConsecutiveFailures: 3 });
  health.recordFailure('a');
  health.recordFailure('a', { timeout: true });
  assert.equal(health.get('a').state, BackendHealthState.HEALTHY);
  health.recordFailure('a');
  assert.equal(health.get('a').state, BackendHealthState.UNAVAILABLE);
  health.recordSuccess('a');
  assert.equal(health.get('a').consecutiveFailures, 0);
});

test('migration never reuses source conversation id and checkpoint bootstraps target binding', () => {
  const registry = makeRegistry();
  const conversations = new MemoryConversationStore();
  const checkpoints = new CheckpointManager();
  const planner = new ContextMigrationPlanner({ checkpointStore: checkpoints.store });
  const sessionId = 'session-a';
  const providerId = 'dify';
  const appId = 'app';

  const source = conversations.set(sessionId, providerId, appId, { backendId: 'dify-a', conversationId: 'conv-A1' });
  const checkpointResult = checkpoints.create({
    sessionId, backendId: 'dify-a', providerId, appId, sourceGeneration: source.generation, contextVersion: 2,
    messages: [{ role: 'system', content: 'preserve rules' }, { role: 'user', content: 'current task' }],
    compressedMessages: [{ role: 'user', content: 'current task' }], tools: [], reasonCodes: ['CONTEXT_LIMIT'],
  });
  assert.equal(checkpointResult.created, true);

  const plan = planner.plan({
    sessionId, sourceBackendId: 'dify-a', targetBackendId: 'dify-b', providerId, appId,
    targetCapabilities: registry.capabilities('dify-b'), checkpoint: checkpointResult.checkpoint,
  });
  assert.equal(plan.required, true);
  assert.equal(plan.bootstrapRequired, true);
  assert.equal(plan.checkpointId, checkpointResult.checkpoint.checkpointId);
  assert.throws(() => assertNoCrossBackendConversationReuse({ sourceBackendId: 'dify-a', targetBackendId: 'dify-b', conversationId: source.conversationId }), /CROSS_BACKEND_CONVERSATION_ID_FORBIDDEN/);

  const targetGen = conversations.createNextGeneration({ dshConversationId: sessionId, providerId, difyAppId: appId, backendId: 'dify-b', checkpointId: plan.checkpointId, contextVersion: 2 });
  assert.equal(targetGen.conversationId, '');
  conversations.activateGeneration({ dshConversationId: sessionId, providerId, difyAppId: appId, backendId: 'dify-b', generation: targetGen.generation, conversationId: 'conv-B1' });
  assert.equal(conversations.get(sessionId, providerId, appId, 'dify-b').conversationId, 'conv-B1');
  assert.equal(conversations.get(sessionId, providerId, appId, 'dify-a').conversationId, 'conv-A1');
});

test('next round reuses target backend conversation while source binding remains recoverable', () => {
  const conversations = new MemoryConversationStore();
  conversations.set('s', 'dify', 'app', { backendId: 'dify-a', conversationId: 'conv-A1' });
  conversations.set('s', 'dify', 'app', { backendId: 'dify-b', conversationId: 'conv-B1' });
  assert.equal(conversations.get('s', 'dify', 'app', 'dify-b').conversationId, 'conv-B1');
  assert.equal(conversations.get('s', 'dify', 'app', 'dify-a').conversationId, 'conv-A1');
});

test('migration without portable context is blocked', () => {
  const planner = new ContextMigrationPlanner();
  const plan = planner.plan({ sourceBackendId: 'a', targetBackendId: 'b', targetCapabilities: { contextMode: BackendContextMode.STATEFUL } });
  assert.equal(plan.blocked, true);
  assert.ok(plan.reasonCodes.includes('MIGRATION_BLOCKED_NO_PORTABLE_CONTEXT'));
});

test('stateless target uses canonical context and does not create conversation binding requirement', () => {
  const planner = new ContextMigrationPlanner();
  const plan = planner.plan({ sourceBackendId: 'a', targetBackendId: 'local', canonicalContextAvailable: true, targetCapabilities: { contextMode: BackendContextMode.STATELESS } });
  assert.equal(plan.required, true);
  assert.equal(plan.bootstrapRequired, false);
  assert.ok(plan.reasonCodes.includes('MIGRATION_TARGET_STATELESS_CANONICAL'));
});

test('different sessions remain isolated across backend bindings', () => {
  const conversations = new MemoryConversationStore();
  conversations.set('s1', 'dify', 'app', { backendId: 'dify-b', conversationId: 'conv-1' });
  conversations.set('s2', 'dify', 'app', { backendId: 'dify-b', conversationId: 'conv-2' });
  assert.equal(conversations.get('s1', 'dify', 'app', 'dify-b').conversationId, 'conv-1');
  assert.equal(conversations.get('s2', 'dify', 'app', 'dify-b').conversationId, 'conv-2');
});

test('tool ledger survives backend migration and fallback cannot duplicate completed tool', () => {
  const ledger = new ToolExecutionLedger();
  const input = { providerId: 'gateway', appId: 'app', sessionId: 'session-a', toolCallId: 'call-123', arguments: '{"x":1}' };
  ledger.complete(input, 'done');
  const afterMigration = ledger.begin({ ...input, backendId: 'dify-b', conversationId: 'conv-B1' });
  assert.equal(afterMigration.duplicate, true);
  assert.equal(afterMigration.replay, true);
  assert.equal(afterMigration.result, 'done');
  assert.equal(isFallbackEligible({ code: 'DIFY_TIMEOUT' }), true);
  const fallbackAttempt = ledger.begin({ ...input, backendId: 'local', conversationId: '' });
  assert.equal(fallbackAttempt.duplicate, true);
  assert.equal(fallbackAttempt.replay, true);
});

test('fallback eligibility is restricted to timeout, unavailable, and 5xx', () => {
  assert.equal(isFallbackEligible({ code: 'TIMEOUT' }), true);
  assert.equal(isFallbackEligible({ code: 'BACKEND_UNAVAILABLE' }), true);
  assert.equal(isFallbackEligible({ status: 503 }), true);
  assert.equal(isFallbackEligible({ status: 400 }), false);
  assert.equal(isFallbackEligible({ code: 'CAPABILITY_MISMATCH' }), false);
});
