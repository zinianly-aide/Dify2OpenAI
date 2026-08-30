import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BackendConversationGenerationState,
  BackendConversationGenerationStore,
  CanonicalContextBuilder,
  CheckpointManager,
  ContextCheckpointStore,
  backendContextReductionPct,
  pendingToolStateOf,
} from '../packages/dify-core/index.js';

const scope = { sessionId: 'session-a', backendId: 'dify-backend-a', providerId: 'dify', appId: 'app-a' };

function messages() {
  return [
    { role: 'system', content: 'SYSTEM KEEP' },
    { role: 'developer', content: 'DEVELOPER KEEP' },
    { role: 'user', content: 'Fix src/app.js and preserve GatewayObserver.observe decision.' },
    { role: 'assistant', content: 'Decision: keep lifecycle authoritative. Error: HTTP 500 from src/app.js' },
    { role: 'user', content: 'CURRENT TASK: rotate Dify conversation safely' },
  ];
}

test('deterministic checkpoint preserves current task, instructions and important metadata', () => {
  const store = new ContextCheckpointStore();
  const manager = new CheckpointManager({ store, builder: new CanonicalContextBuilder({ recentTurns: 2 }) });
  const source = messages();
  const result = manager.create({
    ...scope,
    sourceGeneration: 1,
    contextVersion: 1,
    messages: source,
    compressedMessages: [{ role: 'assistant', gatewayCompressionSummary: true, content: 'Compressed prior context: src/app.js GatewayObserver.observe HTTP 500' }, ...source.slice(-2)],
    compressionResult: { beforeTokens: 90000, afterTokens: 40000 },
    reasonCodes: ['backend_context_amplification_high'],
  });
  assert.equal(result.created, true);
  assert.equal(result.checkpoint.sourceGeneration, 1);
  assert.equal(result.checkpoint.estimatedTokensBefore, 90000);
  assert.ok(result.checkpoint.taskGoals[0].includes('CURRENT TASK'));
  assert.ok(result.checkpoint.activeFiles.includes('src/app.js'));
  assert.ok(result.checkpoint.importantSymbols.includes('GatewayObserver.observe'));
  assert.ok(result.checkpoint.unresolvedErrors.some((x) => /HTTP 500/i.test(x)));
  assert.ok(result.checkpoint.recentMessages.some((m) => m.role === 'user' && /CURRENT TASK/.test(m.content)));
  assert.equal(store.latest(scope.sessionId, scope.backendId, scope.providerId, scope.appId).checkpointId, result.checkpoint.checkpointId);
});

test('pending tool chain defers checkpoint and rotation', () => {
  const source = [
    ...messages(),
    { role: 'assistant', tool_calls: [{ id: 'call-123', type: 'function', function: { name: 'read_file', arguments: '{"path":"src/app.js"}' } }] },
  ];
  assert.equal(pendingToolStateOf(source).pending, true);
  const manager = new CheckpointManager();
  const result = manager.create({ ...scope, sourceGeneration: 1, messages: source, compressionResult: { beforeTokens: 10, afterTokens: 10 } });
  assert.equal(result.created, false);
  assert.equal(result.deferred, true);
  assert.deepEqual(result.reasonCodes, ['ROTATION_DEFERRED_PENDING_TOOL']);
});

test('matched tool result reaches a safe checkpoint boundary', () => {
  const source = [
    ...messages(),
    { role: 'assistant', tool_calls: [{ id: 'call-123', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call-123', content: 'done' },
  ];
  assert.equal(pendingToolStateOf(source).pending, false);
  const result = new CheckpointManager().create({ ...scope, sourceGeneration: 1, messages: source, compressionResult: { beforeTokens: 10, afterTokens: 8 } });
  assert.equal(result.created, true);
  assert.ok(result.checkpoint.recentMessages.some((m) => m.tool_call_id === 'call-123'));
});

test('two phase generation rotation keeps old ACTIVE until target activation', () => {
  const store = new BackendConversationGenerationStore();
  const gen1 = store.ensureActive({ ...scope, conversationId: 'conv-001' });
  assert.equal(gen1.generation, 1);
  assert.equal(gen1.state, BackendConversationGenerationState.ACTIVE);

  const gen2 = store.createNextGeneration({ ...scope, checkpointId: 'cp-1', contextVersion: 2 });
  assert.equal(gen2.generation, 2);
  assert.equal(gen2.conversationId, '');
  assert.equal(gen2.state, BackendConversationGenerationState.BOOTSTRAPPING);
  assert.equal(store.getActiveGeneration(scope.sessionId, scope.backendId, scope.providerId, scope.appId).conversationId, 'conv-001');

  store.activateGeneration({ ...scope, generation: 2, conversationId: 'conv-002' });
  assert.equal(store.getActiveGeneration(scope.sessionId, scope.backendId, scope.providerId, scope.appId).conversationId, 'conv-002');
  assert.equal(store.getGeneration(scope.sessionId, scope.backendId, scope.providerId, scope.appId, 1).state, BackendConversationGenerationState.CHECKPOINTED);
  assert.equal(store.listGenerations(scope.sessionId, scope.backendId, scope.providerId, scope.appId).length, 2);
});

test('rotation bootstrap failure invalidates target and preserves old ACTIVE generation', () => {
  const store = new BackendConversationGenerationStore();
  store.ensureActive({ ...scope, conversationId: 'conv-001' });
  const gen2 = store.createNextGeneration({ ...scope, checkpointId: 'cp-1', contextVersion: 2 });
  store.invalidateGeneration(scope.sessionId, scope.backendId, scope.providerId, scope.appId, gen2.generation, 'BOOTSTRAP_FAILED');
  assert.equal(store.getGeneration(scope.sessionId, scope.backendId, scope.providerId, scope.appId, 2).state, BackendConversationGenerationState.INVALID);
  assert.equal(store.getActiveGeneration(scope.sessionId, scope.backendId, scope.providerId, scope.appId).conversationId, 'conv-001');
});

test('missing conversation id cannot activate target and old ACTIVE is preserved', () => {
  const store = new BackendConversationGenerationStore();
  store.ensureActive({ ...scope, conversationId: 'conv-001' });
  store.createNextGeneration({ ...scope, checkpointId: 'cp-1', contextVersion: 2 });
  assert.throws(() => store.activateGeneration({ ...scope, generation: 2, conversationId: '' }), /ROTATION_MISSING_CONVERSATION_ID/);
  assert.equal(store.getActiveGeneration(scope.sessionId, scope.backendId, scope.providerId, scope.appId).conversationId, 'conv-001');
});

test('provider/app/session scopes recover only their latest ACTIVE generation', () => {
  const store = new BackendConversationGenerationStore();
  store.ensureActive({ ...scope, conversationId: 'conv-a1' });
  const a2 = store.createNextGeneration({ ...scope, checkpointId: 'cp-a', contextVersion: 2 });
  store.activateGeneration({ ...scope, generation: a2.generation, conversationId: 'conv-a2' });
  store.ensureActive({ sessionId: 'session-a', backendId: 'other-backend', providerId: 'openai', appId: 'model-x', conversationId: 'other-conv' });
  store.ensureActive({ sessionId: 'session-b', backendId: scope.backendId, providerId: scope.providerId, appId: scope.appId, conversationId: 'session-b-conv' });
  store.ensureActive({ sessionId: 'session-a', backendId: 'dify-backend-b', providerId: 'dify', appId: 'app-b', conversationId: 'app-b-conv' });
  assert.equal(store.getActiveGeneration(scope.sessionId, scope.backendId, scope.providerId, scope.appId).conversationId, 'conv-a2');
  assert.equal(store.getGeneration(scope.sessionId, scope.backendId, scope.providerId, scope.appId, 1).state, BackendConversationGenerationState.CHECKPOINTED);
  assert.equal(store.getActiveGeneration('session-b', scope.backendId, scope.providerId, scope.appId).conversationId, 'session-b-conv');
  assert.equal(store.getActiveGeneration('session-a', 'dify-backend-b', 'dify', 'app-b').conversationId, 'app-b-conv');
});

test('backend context reduction uses only actual backend usage', () => {
  assert.equal(backendContextReductionPct(90000, 30000), 66.66666666666666);
  assert.equal(backendContextReductionPct(undefined, 30000), undefined);
  assert.equal(backendContextReductionPct(90000, undefined), undefined);
});
