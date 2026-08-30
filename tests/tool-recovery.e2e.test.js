import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AdaptiveBackendGateway,
  BackendHealthStore,
  BackendProviderType,
  BackendRegistry,
  CheckpointManager,
  ContextMigrationPlanner,
  DeterministicBackendRouter,
  MemoryConversationStore,
  ToolExecutionLedger,
} from '../packages/dify-core/index.js';

function tool(name) {
  return {
    type: 'function',
    function: {
      name,
      description: `Deterministic ${name} capability`,
      parameters: { type: 'object', properties: { value: { type: 'string' }, extra: { type: 'string' } } },
    },
  };
}

function tools25() { return Array.from({ length: 25 }, (_, i) => tool(`tool_${i + 1}`)); }

function statelessRegistry() {
  return new BackendRegistry([{
    backendId: 'openai-a', providerType: BackendProviderType.OPENAI_COMPATIBLE, baseUrl: 'http://openai-a/v1', model: 'a', enabled: true,
    maxContextWindow: 128000, supportsTools: true, supportsVision: true, supportsStreaming: true, supportsReasoning: true,
    statefulContext: false, costTier: 'medium', priority: 10,
  }]);
}

function gatewayFor(registry, executor, options = {}) {
  const healthStore = new BackendHealthStore();
  const conversations = options.conversations || new MemoryConversationStore();
  const checkpoints = options.checkpoints || new CheckpointManager();
  const ledger = options.ledger || new ToolExecutionLedger();
  return {
    conversations,
    checkpoints,
    ledger,
    gateway: new AdaptiveBackendGateway({
      registry,
      router: new DeterministicBackendRouter({ registry, healthStore }),
      migrationPlanner: new ContextMigrationPlanner({ checkpointStore: checkpoints.store }),
      conversationStore: conversations,
      checkpointManager: checkpoints,
      healthStore,
      toolLedger: ledger,
      executor,
    }),
  };
}

test('Case C: pruned request recovers full toolset exactly once on explicit missing-tool condition', async () => {
  const calls = [];
  const executor = {
    async execute(input) {
      calls.push({ tools: input.tools.map((t) => t.function.name), messages: input.messages });
      if (calls.length === 1) {
        const error = new Error('missing required tool tool_20');
        error.code = 'MISSING_TOOL';
        throw error;
      }
      return { answer: 'recovered', toolCalls: [{ id: 'call-new', function: { name: 'tool_20', arguments: '{}' } }], conversationId: '' };
    },
  };
  const { gateway } = gatewayFor(statelessRegistry(), executor);
  const tools = tools25();
  const result = await gateway.execute({
    sessionId: 'recover-session', providerId: 'gateway', appId: 'app', clientType: 'dsh', taskType: 'coding',
    messages: [{ role: 'user', content: 'use the required helper' }], canonicalMessages: [{ role: 'user', content: 'use the required helper' }],
    tools, requiresTools: true, requiredTools: ['tool_1'], estimatedTokens: 1000,
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].tools, ['tool_1']);
  assert.equal(calls[1].tools.length, 25);
  assert.equal(result.toolOptimization.recoveryTriggered, true);
  assert.equal(result.toolOptimization.recoverySuccess, true);
  assert.equal(result.toolOptimization.recoveryReason, 'MISSING_TOOL');
});

test('full tool recovery never loops beyond one retry', async () => {
  let attempts = 0;
  const executor = {
    async execute() {
      attempts += 1;
      const error = new Error('unknown tool needed');
      error.code = 'MISSING_TOOL';
      throw error;
    },
  };
  const { gateway } = gatewayFor(statelessRegistry(), executor);
  await assert.rejects(() => gateway.execute({
    sessionId: 'recover-once', providerId: 'gateway', appId: 'app', clientType: 'dsh',
    messages: [{ role: 'user', content: 'task' }], tools: tools25(), requiresTools: true, requiredTools: ['tool_1'], estimatedTokens: 1000,
  }), /unknown tool needed/);
  assert.equal(attempts, 2);
});

test('Case D: completed call remains idempotent through prune and full recovery', async () => {
  const ledger = new ToolExecutionLedger();
  const completed = { providerId: 'gateway', appId: 'app', sessionId: 'idem-session', toolCallId: 'call-123', toolName: 'tool_1', arguments: '{"value":"x"}' };
  ledger.complete(completed, 'already-done');
  const calls = [];
  const executor = {
    async execute(input) {
      calls.push(input.messages);
      if (calls.length === 1) {
        const error = new Error('tool not found: tool_20');
        error.code = 'TOOL_NOT_FOUND';
        throw error;
      }
      return { answer: 'ok', conversationId: '' };
    },
  };
  const { gateway } = gatewayFor(statelessRegistry(), executor, { ledger });
  const messages = [
    { role: 'assistant', tool_calls: [{ id: 'call-123', function: { name: 'tool_1', arguments: '{"value":"x"}' } }] },
  ];
  await gateway.execute({
    sessionId: 'idem-session', providerId: 'gateway', appId: 'app', clientType: 'dsh', messages, canonicalMessages: messages,
    tools: tools25(), requiresTools: true, requiredTools: ['tool_1'], completedToolInputs: [completed], estimatedTokens: 1000,
  });
  assert.equal(calls.length, 2);
  for (const sent of calls) {
    assert.equal(sent.filter((m) => m.role === 'tool' && m.tool_call_id === 'call-123').length, 1);
  }
  const duplicate = ledger.begin({ ...completed, backendId: 'another', conversationId: 'different' });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.replay, true);
});

test('backend migration creates target generation, reinjects selected schema, and next round reuses generation schema scope', async () => {
  const registry = new BackendRegistry([
    {
      backendId: 'dify-a', providerType: BackendProviderType.DIFY, baseUrl: 'http://a/v1', model: 'a', enabled: true,
      maxContextWindow: 32000, supportsTools: true, supportsVision: false, supportsStreaming: true, supportsReasoning: false,
      statefulContext: true, costTier: 'medium', priority: 10,
    },
    {
      backendId: 'dify-b', providerType: BackendProviderType.DIFY, baseUrl: 'http://b/v1', model: 'b', enabled: true,
      maxContextWindow: 128000, supportsTools: true, supportsVision: true, supportsStreaming: true, supportsReasoning: true,
      statefulContext: true, costTier: 'high', priority: 20,
    },
  ]);
  const calls = [];
  const executor = {
    async execute(input) {
      calls.push({ backendId: input.backend.backendId, conversationId: input.conversationId, tools: input.tools.map((t) => t.function.name) });
      return { answer: 'ok', conversationId: input.conversationId || 'conv-B1' };
    },
  };
  const conversations = new MemoryConversationStore();
  conversations.set('migration-session', 'gateway', 'app', { backendId: 'dify-a', conversationId: 'conv-A1' });
  const { gateway } = gatewayFor(registry, executor, { conversations });
  const common = {
    sessionId: 'migration-session', providerId: 'gateway', appId: 'app', clientType: 'dsh', taskType: 'coding',
    messages: [{ role: 'user', content: 'continue task' }], canonicalMessages: [{ role: 'user', content: 'continue task' }],
    tools: tools25(), requiresTools: true, requiredTools: ['tool_2'], estimatedTokens: 90000,
  };
  const migrated = await gateway.execute({ ...common, currentBackendId: 'dify-a' });
  assert.equal(migrated.routing.selectedBackend, 'dify-b');
  assert.equal(migrated.routing.migrationRequired, true);
  assert.equal(calls[0].backendId, 'dify-b');
  assert.equal(calls[0].conversationId, '');
  assert.deepEqual(calls[0].tools, ['tool_2']);
  assert.equal(migrated.toolOptimization.schemaReinjectionRequired, true);
  assert.equal(conversations.get('migration-session', 'gateway', 'app', 'dify-a').conversationId, 'conv-A1');
  assert.equal(conversations.get('migration-session', 'gateway', 'app', 'dify-b').conversationId, 'conv-B1');

  const continued = await gateway.execute(common);
  assert.equal(calls[1].backendId, 'dify-b');
  assert.equal(calls[1].conversationId, 'conv-B1');
  assert.deepEqual(calls[1].tools, ['tool_2']);
  assert.equal(continued.toolOptimization.schemaReinjectionRequired, false);
});
