import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ToolPruner,
  ToolRelevancePolicy,
  ToolSchemaCostEstimator,
  ToolSchemaRegistry,
  ToolUsageProfiler,
} from '../packages/dify-core/index.js';

function tool(name, description = '') {
  return {
    type: 'function',
    function: {
      name,
      description: description || `Tool ${name}`,
      parameters: {
        type: 'object',
        properties: {
          value: { type: 'string', description: `Input for ${name}` },
          options: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  };
}

function tools25() {
  return Array.from({ length: 25 }, (_, i) => tool(`tool_${i + 1}`, `category-${i + 1} deterministic helper`));
}

test('Case A: 25 tools safely prune with positive schema savings', () => {
  const tools = tools25();
  const policy = new ToolRelevancePolicy();
  const profile = new ToolUsageProfiler().get({ sessionId: 's', clientType: 'dsh', backendId: 'b' });
  const classified = policy.classify({
    canonicalRequest: { clientType: 'dsh', taskType: 'general' },
    tools,
    profile,
    backendCapabilities: { supportsTools: true },
    explicitRequiredTools: ['tool_3', 'tool_7'],
  });
  const result = new ToolPruner().prune({ availableTools: tools, profile, policyResult: classified });
  assert.equal(result.beforeToolCount, 25);
  assert.ok(result.afterToolCount < 25);
  assert.ok(result.savedTokens > 0);
  assert.deepEqual(result.selectedTools.map((t) => t.function.name).sort(), ['tool_3', 'tool_7']);
});

test('pending tool is REQUIRED and never pruned', () => {
  const tools = [tool('search'), tool('write'), tool('read')];
  const messages = [{ role: 'assistant', tool_calls: [{ id: 'call-pending', function: { name: 'write', arguments: '{}' } }] }];
  const policy = new ToolRelevancePolicy();
  const classified = policy.classify({ tools, messages, profile: {}, backendCapabilities: { supportsTools: true } });
  const result = new ToolPruner().prune({ availableTools: tools, policyResult: classified });
  assert.ok(result.selectedTools.some((t) => t.function.name === 'write'));
});

test('recent critical tool is retained', () => {
  const tools = [tool('deploy'), tool('read'), tool('search')];
  const policy = new ToolRelevancePolicy({ criticalTools: ['deploy'] });
  const classified = policy.classify({
    tools,
    profile: { recentlyUsedTools: ['deploy'], toolUsageFrequency: { deploy: 2 }, pendingTools: [] },
    backendCapabilities: { supportsTools: true },
  });
  const result = new ToolPruner().prune({ availableTools: tools, policyResult: classified });
  assert.ok(result.selectedTools.some((t) => t.function.name === 'deploy'));
});

test('Case B: low confidence sends all 25 tools', () => {
  const tools = tools25();
  const policy = new ToolRelevancePolicy();
  const classified = policy.classify({ tools, profile: {}, backendCapabilities: { supportsTools: true } });
  assert.equal(classified.confidence, 'low');
  const result = new ToolPruner().prune({ availableTools: tools, policyResult: classified });
  assert.equal(result.afterToolCount, 25);
  assert.equal(result.mode, 'SEND_ALL');
  assert.equal(result.savedTokens, 0);
});

test('schema estimator is deterministic per canonical tool schema', () => {
  const estimator = new ToolSchemaCostEstimator();
  const a = estimator.estimate(tool('read'));
  const b = estimator.estimate(tool('read'));
  assert.equal(a.schemaHash, b.schemaHash);
  assert.equal(a.estimatedTokens, b.estimatedTokens);
  assert.ok(a.estimatedTokens > 0);
});

test('new generation forces schema reinjection while unchanged same generation is reused', () => {
  const registry = new ToolSchemaRegistry();
  const tools = [tool('read'), tool('search')];
  const first = registry.resolve({ dshConversationId: 's', providerId: 'p', difyAppId: 'a', backendId: 'b', generation: 1, tools });
  const same = registry.resolve({ dshConversationId: 's', providerId: 'p', difyAppId: 'a', backendId: 'b', generation: 1, tools });
  const next = registry.resolve({ dshConversationId: 's', providerId: 'p', difyAppId: 'a', backendId: 'b', generation: 2, tools });
  assert.equal(first.reinjectionRequired, true);
  assert.equal(same.reinjectionRequired, false);
  assert.equal(next.reinjectionRequired, true);
  assert.equal(first.toolSchemaHash, next.toolSchemaHash);
});

test('schema registry is backend isolated', () => {
  const registry = new ToolSchemaRegistry();
  const tools = [tool('read')];
  registry.resolve({ dshConversationId: 's', providerId: 'p', difyAppId: 'a', backendId: 'a', generation: 1, tools });
  const other = registry.resolve({ dshConversationId: 's', providerId: 'p', difyAppId: 'a', backendId: 'b', generation: 1, tools });
  assert.equal(other.reinjectionRequired, true);
});

test('usage profiler records metadata only and keeps sessions/backends isolated', () => {
  const profiler = new ToolUsageProfiler();
  const a = { sessionId: 's1', clientType: 'dsh', backendId: 'a' };
  const b = { sessionId: 's1', clientType: 'dsh', backendId: 'b' };
  const c = { sessionId: 's2', clientType: 'dsh', backendId: 'a' };
  profiler.recordRequest(a, { tools: [tool('read')], schemaTokens: 10, pendingTools: ['read'] });
  profiler.recordOutcome(a, { toolName: 'read', success: true });
  profiler.recordOutcome(a, { toolName: 'read', success: false });
  const pa = profiler.get(a);
  assert.equal(pa.toolCount, 1);
  assert.equal(pa.toolSchemaTokens, 10);
  assert.equal(pa.toolUsageFrequency.read, 2);
  assert.equal(pa.toolSuccessRate, 0.5);
  assert.equal(pa.toolFailureRate, 0.5);
  assert.deepEqual(pa.pendingTools, ['read']);
  assert.equal(profiler.get(b).toolCount, 0);
  assert.equal(profiler.get(c).toolCount, 0);
  assert.equal(JSON.stringify(pa).includes('arguments'), false);
  assert.equal(JSON.stringify(pa).includes('result'), false);
});
