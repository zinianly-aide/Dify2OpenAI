import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import dshChatHandler from '../botType/dshChatHandler.js';
import { backendIdFromUrl } from '../lib/gateway/canonical.js';
import { conversationStore } from '../lib/runtime.js';

function response(locals = {}) {
  return {
    statusCode: 200, locals, payload: null, headers: {},
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    json(value) { this.payload = value; return value; },
    write() { return true; }, end() {},
  };
}

async function invoke(baseUrl, sessionId, messages, locals) {
  const req = {
    headers: { 'x-dsh-conversation-id': sessionId, 'x-dify-app-id': 'boundary-app', 'x-provider-id': 'dify' },
    body: { model: 'dify', stream: false, messages },
  };
  const res = response(locals);
  await dshChatHandler.handleRequest(req, res, { DIFY_API_URL: baseUrl, API_KEY: 'test-key' });
  return res;
}

async function fake(handler, run) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    requests.push(body);
    const result = await handler(body, requests.length - 1);
    res.statusCode = result.status || 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(result.body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try { await run(baseUrl, requests); } finally { await new Promise((resolve) => server.close(resolve)); }
}

const compression = { beforeTokens: 1000, afterTokens: 700, targetReached: true, unableToReachTarget: false, reasonCodes: [] };
const messages = (text) => [{ role: 'system', content: 'keep system' }, { role: 'user', content: text }];

test('checkpoint false does not rotate or create a new generation', async () => {
  await fake(async (_body, index) => ({ body: { conversation_id: 'conv-stable', answer: `ok-${index}`, usage: { prompt_tokens: 700, completion_tokens: 1 } } }), async (baseUrl, requests) => {
    const sessionId = 'no-rotation-session';
    const backendId = backendIdFromUrl(baseUrl);
    const firstMessages = messages('first');
    await invoke(baseUrl, sessionId, firstMessages, { gatewayOriginalMessages: firstMessages, gatewayCompressionResult: compression, gatewayBackendId: backendId });
    const secondMessages = messages('second');
    const second = await invoke(baseUrl, sessionId, secondMessages, { gatewayOriginalMessages: secondMessages, gatewayCompressionResult: compression, gatewayBackendId: backendId });
    assert.equal(second.statusCode, 200);
    assert.equal(requests[1].conversation_id, 'conv-stable');
    assert.equal(conversationStore.listGenerations(sessionId, 'dify', 'boundary-app', backendId).length, 1);
    assert.equal(second.locals.gatewayRotation, undefined);
  });
});

test('rotation response missing conversation_id invalidates target and preserves old ACTIVE', async () => {
  await fake(async (_body, index) => {
    if (index === 0) return { body: { conversation_id: 'conv-old-active', answer: 'first', usage: { prompt_tokens: 90000, completion_tokens: 10 } } };
    return { body: { answer: 'bootstrap without id', usage: { prompt_tokens: 30000, completion_tokens: 10 } } };
  }, async (baseUrl, requests) => {
    const sessionId = 'missing-conversation-id-session';
    const backendId = backendIdFromUrl(baseUrl);
    const firstMessages = messages('first');
    await invoke(baseUrl, sessionId, firstMessages, { gatewayOriginalMessages: firstMessages, gatewayCompressionResult: { ...compression, afterTokens: 30000, beforeTokens: 50000 }, gatewayBackendId: backendId });
    const rotateMessages = messages('rotate');
    const failed = await invoke(baseUrl, sessionId, rotateMessages, { gatewayOriginalMessages: rotateMessages, gatewayCompressionResult: { ...compression, afterTokens: 30000, beforeTokens: 50000 }, gatewayBackendId: backendId });
    assert.equal(requests[1].conversation_id, '');
    assert.equal(failed.statusCode, 502);
    assert.equal(failed.locals.gatewayRotation.rotationFailureReason, 'ROTATION_MISSING_CONVERSATION_ID');
    const generations = conversationStore.listGenerations(sessionId, 'dify', 'boundary-app', backendId);
    assert.equal(generations.length, 2);
    assert.equal(generations[0].state, 'ACTIVE');
    assert.equal(generations[0].conversationId, 'conv-old-active');
    assert.equal(generations[1].state, 'INVALID');
  });
});
