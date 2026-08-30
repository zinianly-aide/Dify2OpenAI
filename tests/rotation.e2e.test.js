import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import dshChatHandler from '../botType/dshChatHandler.js';
import { backendIdFromUrl } from '../lib/gateway/canonical.js';
import { conversationStore, rotationRecommendationStore, toolExecutionLedger } from '../lib/runtime.js';

function makeResponse(locals = {}) {
  return {
    statusCode: 200,
    headers: {},
    payload: null,
    chunks: [],
    locals,
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    json(value) { this.payload = value; return value; },
    write(value) { this.chunks.push(String(value)); return true; },
    end(value = '') { if (value) this.chunks.push(String(value)); },
  };
}

async function invoke({ baseUrl, sessionId, appId = 'rotation-app', body, locals = {} }) {
  const req = {
    headers: {
      'x-dsh-conversation-id': sessionId,
      'x-dify-app-id': appId,
      'x-provider-id': 'dify',
    },
    body: { model: 'dify', stream: false, ...body },
  };
  const res = makeResponse(locals);
  await dshChatHandler.handleRequest(req, res, { DIFY_API_URL: baseUrl, API_KEY: 'test-key' });
  return res;
}

async function withFakeDify(handler, run) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    requests.push(body);
    const result = await handler(body, requests.length - 1);
    res.statusCode = result.status ?? 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(result.body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  try { await run({ baseUrl, requests }); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

const healthyCompression = { beforeTokens: 50000, afterTokens: 30000, targetReached: true, unableToReachTarget: false, reasonCodes: [] };

function authoritative(turn) {
  return [
    { role: 'system', content: 'SYSTEM KEEP' },
    { role: 'developer', content: 'DEVELOPER KEEP' },
    { role: 'user', content: 'Earlier task src/app.js GatewayObserver.observe' },
    { role: 'assistant', content: 'Decision: preserve lifecycle state' },
    { role: 'user', content: `CURRENT REQUEST ${turn}` },
  ];
}

test('HTTP rotation E2E: conv-001 -> checkpoint -> generation 2 -> conv-002 -> continue conv-002', async () => {
  await withFakeDify(async (_body, index) => {
    if (index === 0) return { body: { conversation_id: 'conv-001', answer: 'first', usage: { prompt_tokens: 90000, completion_tokens: 100 } } };
    if (index === 1) return { body: { conversation_id: 'conv-002', answer: 'rotated', usage: { prompt_tokens: 30000, completion_tokens: 100 } } };
    return { body: { conversation_id: 'conv-002', answer: 'continued', usage: { prompt_tokens: 32000, completion_tokens: 100 } } };
  }, async ({ baseUrl, requests }) => {
    const sessionId = 'rotation-e2e-session-a';
    const backendId = backendIdFromUrl(baseUrl);
    const firstMessages = authoritative('one');
    const first = await invoke({
      baseUrl,
      sessionId,
      body: { messages: firstMessages },
      locals: { gatewayOriginalMessages: firstMessages, gatewayCompressionResult: healthyCompression, gatewayBackendId: backendId },
    });
    assert.equal(first.statusCode, 200);
    assert.equal(requests[0].conversation_id, '');
    assert.equal(conversationStore.getActiveGeneration(sessionId, 'dify', 'rotation-app', backendId).conversationId, 'conv-001');
    assert.equal(rotationRecommendationStore.get(sessionId, backendId, 'dify', 'rotation-app').recommended, true);

    const secondMessages = authoritative('two');
    const second = await invoke({
      baseUrl,
      sessionId,
      body: { messages: secondMessages },
      locals: { gatewayOriginalMessages: secondMessages, gatewayCompressionResult: healthyCompression, gatewayBackendId: backendId },
    });
    assert.equal(second.statusCode, 200);
    assert.equal(requests[1].conversation_id, '');
    assert.match(requests[1].query, /Context checkpoint:/);
    assert.match(requests[1].query, /CURRENT REQUEST two/);
    assert.equal(second.locals.gatewayRotation.sourceGeneration, 1);
    assert.equal(second.locals.gatewayRotation.targetGeneration, 2);
    assert.equal(second.locals.gatewayRotation.rotationSuccess, true);
    assert.ok(second.locals.gatewayRotation.backendContextReductionPct > 60);

    const generations = conversationStore.listGenerations(sessionId, 'dify', 'rotation-app', backendId);
    assert.equal(generations.length, 2);
    assert.equal(generations[0].conversationId, 'conv-001');
    assert.equal(generations[0].state, 'CHECKPOINTED');
    assert.equal(generations[1].conversationId, 'conv-002');
    assert.equal(generations[1].state, 'ACTIVE');

    const thirdMessages = authoritative('three');
    const third = await invoke({
      baseUrl,
      sessionId,
      body: { messages: thirdMessages },
      locals: { gatewayOriginalMessages: thirdMessages, gatewayCompressionResult: healthyCompression, gatewayBackendId: backendId },
    });
    assert.equal(third.statusCode, 200);
    assert.equal(requests[2].conversation_id, 'conv-002');
    assert.match(requests[2].query, /CURRENT REQUEST three/);
  });
});

test('rotation bootstrap failure leaves generation 1 ACTIVE', async () => {
  await withFakeDify(async (_body, index) => index === 0
    ? { body: { conversation_id: 'conv-fallback-001', answer: 'first', usage: { prompt_tokens: 30000, completion_tokens: 1 } } }
    : { status: 500, body: { message: 'bootstrap failed' } }, async ({ baseUrl, requests }) => {
      const sessionId = 'rotation-failure-session';
      const backendId = backendIdFromUrl(baseUrl);
      const firstMessages = authoritative('first');
      await invoke({ baseUrl, sessionId, body: { messages: firstMessages }, locals: { gatewayOriginalMessages: firstMessages, gatewayCompressionResult: healthyCompression, gatewayBackendId: backendId } });
      rotationRecommendationStore.set(sessionId, backendId, 'dify', 'rotation-app', { reasonCodes: ['compression_target_unreachable'] });
      const secondMessages = authoritative('rotate now');
      const failed = await invoke({ baseUrl, sessionId, body: { messages: secondMessages }, locals: { gatewayOriginalMessages: secondMessages, gatewayCompressionResult: healthyCompression, gatewayBackendId: backendId } });
      assert.equal(failed.statusCode, 500);
      assert.equal(requests[1].conversation_id, '');
      const generations = conversationStore.listGenerations(sessionId, 'dify', 'rotation-app', backendId);
      assert.equal(generations[0].state, 'ACTIVE');
      assert.equal(generations[0].conversationId, 'conv-fallback-001');
      assert.equal(generations[1].state, 'INVALID');
      assert.equal(failed.locals.gatewayRotation.rotationSuccess, false);
    });
});

test('pending tool call defers rotation and keeps current ACTIVE conversation', async () => {
  await withFakeDify(async (_body, index) => ({ body: { conversation_id: 'conv-tool-stable', answer: index ? 'continued' : 'first', usage: { prompt_tokens: 30000, completion_tokens: 1 } } }), async ({ baseUrl, requests }) => {
    const sessionId = 'rotation-pending-tool-session';
    const backendId = backendIdFromUrl(baseUrl);
    const firstMessages = authoritative('first');
    await invoke({ baseUrl, sessionId, body: { messages: firstMessages }, locals: { gatewayOriginalMessages: firstMessages, gatewayCompressionResult: healthyCompression, gatewayBackendId: backendId } });
    rotationRecommendationStore.set(sessionId, backendId, 'dify', 'rotation-app', { reasonCodes: ['compression_target_unreachable'] });
    const pendingMessages = [
      ...authoritative('pending tool'),
      { role: 'assistant', tool_calls: [{ id: 'call-pending', type: 'function', function: { name: 'read_file', arguments: '{"path":"src/app.js"}' } }] },
    ];
    const deferred = await invoke({ baseUrl, sessionId, body: { messages: pendingMessages }, locals: { gatewayOriginalMessages: pendingMessages, gatewayCompressionResult: healthyCompression, gatewayBackendId: backendId } });
    assert.equal(deferred.statusCode, 200);
    assert.equal(requests[1].conversation_id, 'conv-tool-stable');
    assert.equal(deferred.locals.gatewayRotation.rotationFailureReason, 'ROTATION_DEFERRED_PENDING_TOOL');
    assert.equal(conversationStore.listGenerations(sessionId, 'dify', 'rotation-app', backendId).length, 1);
  });
});

test('tool ledger identity remains stable across backend generations', () => {
  const input = { providerId: 'dify', appId: 'rotation-ledger-app', sessionId: 'ledger-session', toolCallId: 'call-123', arguments: '{"x":1}' };
  toolExecutionLedger.complete(input, 'done-on-generation-1');
  const afterRotation = toolExecutionLedger.begin(input);
  assert.equal(afterRotation.duplicate, true);
  assert.equal(afterRotation.replay, true);
  assert.equal(afterRotation.result, 'done-on-generation-1');
});
