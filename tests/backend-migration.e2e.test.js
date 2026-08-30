import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  AdaptiveBackendGateway,
  BackendAffinityStore,
  BackendExecutor,
  BackendHealthStore,
  BackendProviderType,
  BackendRegistry,
  CheckpointManager,
  ContextMigrationPlanner,
  DeterministicBackendRouter,
  MemoryConversationStore,
  ToolExecutionLedger,
} from '../packages/dify-core/index.js';

async function fakeDify(name, handler) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    requests.push({ path: req.url, body });
    const reply = handler({ index: requests.length - 1, body });
    res.statusCode = reply.status || 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(reply.body || { answer: name, conversation_id: `${name}-conv` }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { baseUrl: `http://127.0.0.1:${port}`, requests, close: () => new Promise((resolve) => server.close(resolve)) };
}

test('E2E: context migration rotates Dify A to B, reuses B, then 5xx falls back without repeating completed tool', async (t) => {
  let bUnavailable = false;
  const difyA = await fakeDify('A', ({ index, body }) => ({
    body: { answer: `A-${index}`, conversation_id: index === 0 ? 'conv-A2' : 'conv-A3', metadata: { usage: { prompt_tokens: 20000, completion_tokens: 10 } } },
  }));
  const difyB = await fakeDify('B', ({ index }) => {
    if (bUnavailable) return { status: 503, body: { message: 'unavailable' } };
    return { body: { answer: `B-${index}`, conversation_id: 'conv-B1', metadata: { usage: { prompt_tokens: 30000, completion_tokens: 10 } } } };
  });
  t.after(async () => { await difyA.close(); await difyB.close(); });

  const registry = new BackendRegistry([
    {
      backendId: 'dify-a', providerType: BackendProviderType.DIFY, baseUrl: difyA.baseUrl, model: 'a', enabled: true,
      maxContextWindow: 32000, supportsTools: true, supportsVision: false, supportsStreaming: true, supportsReasoning: false,
      statefulContext: true, costTier: 'medium', priority: 10,
    },
    {
      backendId: 'dify-b', providerType: BackendProviderType.DIFY, baseUrl: difyB.baseUrl, model: 'b', enabled: true,
      maxContextWindow: 128000, supportsTools: true, supportsVision: true, supportsStreaming: true, supportsReasoning: true,
      statefulContext: true, costTier: 'high', priority: 20,
    },
  ]);
  const health = new BackendHealthStore();
  const conversations = new MemoryConversationStore();
  const checkpoints = new CheckpointManager();
  const ledger = new ToolExecutionLedger();
  const affinity = new BackendAffinityStore();
  const router = new DeterministicBackendRouter({ registry, healthStore: health });
  const gateway = new AdaptiveBackendGateway({
    registry,
    router,
    migrationPlanner: new ContextMigrationPlanner({ checkpointStore: checkpoints.store }),
    conversationStore: conversations,
    checkpointManager: checkpoints,
    healthStore: health,
    toolLedger: ledger,
    executor: new BackendExecutor(),
    affinityStore: affinity,
  });

  const sessionId = 'session-A';
  const providerId = 'gateway';
  const appId = 'app';
  conversations.set(sessionId, providerId, appId, { backendId: 'dify-a', conversationId: 'conv-A1', contextVersion: 1 });
  affinity.set(sessionId, providerId, appId, 'dify-a');

  const messages = [
    { role: 'system', content: 'preserve instructions' },
    { role: 'user', content: 'continue the current migration task using src/router.js and keep decision ROUTE_SAFE' },
  ];

  const migrated = await gateway.execute({
    sessionId, providerId, appId, messages, estimatedTokens: 90000, contextUtilization: 0.9, requiresTools: true, toolCount: 1,
  });
  assert.equal(migrated.routing.selectedBackend, 'dify-b');
  assert.equal(migrated.routing.migrationRequired, true);
  assert.equal(migrated.migration.bootstrapRequired, true);
  assert.equal(difyB.requests.length, 1);
  assert.equal(difyB.requests[0].body.conversation_id, '');
  assert.match(difyB.requests[0].body.query, /current migration task/);
  assert.equal(conversations.get(sessionId, providerId, appId, 'dify-b').conversationId, 'conv-B1');
  assert.equal(conversations.get(sessionId, providerId, appId, 'dify-a').conversationId, 'conv-A1');

  const continued = await gateway.execute({
    sessionId, providerId, appId, messages: [...messages, { role: 'assistant', content: 'B response' }, { role: 'user', content: 'next round' }],
    estimatedTokens: 20000, contextUtilization: 0.2, requiresTools: true, toolCount: 1,
  });
  assert.equal(continued.routing.selectedBackend, 'dify-b');
  assert.equal(continued.routing.migrationRequired, false);
  assert.equal(difyB.requests[1].body.conversation_id, 'conv-B1');

  const toolInput = { providerId, appId, sessionId, toolCallId: 'call-123', arguments: '{"path":"src/router.js"}' };
  ledger.complete(toolInput, 'tool-result-once');
  bUnavailable = true;

  const fallback = await gateway.execute({
    sessionId, providerId, appId,
    messages: [...messages, { role: 'assistant', content: 'before fallback' }, { role: 'user', content: 'finish safely' }],
    estimatedTokens: 20000, contextUtilization: 0.2, requiresTools: true, toolCount: 1,
    completedToolInputs: [toolInput],
  });
  assert.equal(fallback.routing.fallbackUsed, true);
  assert.equal(fallback.routing.selectedBackend, 'dify-a');
  assert.deepEqual(fallback.attemptedBackends, ['dify-b', 'dify-a']);
  assert.equal(difyA.requests.length, 1);
  assert.equal(difyA.requests[0].body.conversation_id, '');
  assert.match(difyA.requests[0].body.query, /tool-result-once/);
  assert.equal(ledger.begin(toolInput).duplicate, true);
  assert.equal(ledger.begin(toolInput).replay, true);

  const aGenerations = conversations.listGenerations(sessionId, providerId, appId, 'dify-a');
  assert.equal(aGenerations.length, 2);
  assert.equal(aGenerations[0].conversationId, 'conv-A1');
  assert.equal(aGenerations[0].state, 'CHECKPOINTED');
  assert.equal(aGenerations[1].conversationId, 'conv-A2');
  assert.equal(aGenerations[1].state, 'ACTIVE');
  assert.equal(conversations.get(sessionId, providerId, appId, 'dify-b').conversationId, 'conv-B1');
});
