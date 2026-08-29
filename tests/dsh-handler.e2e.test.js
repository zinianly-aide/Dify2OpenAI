import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import dshChatHandler from '../botType/dshChatHandler.js';

function makeResponse() {
  return {
    statusCode: 200,
    headers: {},
    payload: null,
    chunks: [],
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    json(value) { this.payload = value; return value; },
    write(value) { this.chunks.push(String(value)); },
    end(value = '') { if (value) this.chunks.push(String(value)); },
  };
}

async function invoke({ baseUrl, dshConversationId, difyAppId = 'app-a', providerId = 'dify', body }) {
  const req = {
    headers: {
      'x-dsh-conversation-id': dshConversationId,
      'x-dify-app-id': difyAppId,
      'x-provider-id': providerId,
    },
    body: { model: 'dify', stream: false, ...body },
  };
  const res = makeResponse();
  await dshChatHandler.handleRequest(req, res, { DIFY_API_URL: baseUrl, API_KEY: 'test-key' });
  return res;
}

async function withFakeDify(handler, run) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    requests.push({ method: req.method, url: req.url, body, headers: req.headers });
    const result = await handler(body, requests.length - 1);
    res.statusCode = result.status ?? 200;
    res.setHeader('content-type', 'application/json');
    res.end(typeof result.body === 'string' ? result.body : JSON.stringify(result.body));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    await run({ baseUrl, requests });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('HTTP E2E: BOOTSTRAP then DELTA_CONTINUE without resending full history', async () => {
  await withFakeDify(async () => ({ body: { conversation_id: 'conv-e2e-1', answer: 'ok' } }), async ({ baseUrl, requests }) => {
    const id = 'e2e-bootstrap-delta';
    const first = await invoke({
      baseUrl,
      dshConversationId: id,
      body: { messages: [{ role: 'system', content: 'system rules' }, { role: 'user', content: 'first question' }] },
    });
    assert.equal(first.statusCode, 200);
    assert.equal(requests[0].body.conversation_id, '');
    assert.match(requests[0].body.query, /system rules/);
    assert.match(requests[0].body.query, /first question/);

    const second = await invoke({
      baseUrl,
      dshConversationId: id,
      body: { messages: [{ role: 'system', content: 'system rules' }, { role: 'user', content: 'first question' }, { role: 'assistant', content: 'first answer' }, { role: 'user', content: 'second question' }] },
    });
    assert.equal(second.statusCode, 200);
    assert.equal(requests[1].body.conversation_id, 'conv-e2e-1');
    assert.match(requests[1].body.query, /second question/);
    assert.doesNotMatch(requests[1].body.query, /first question/);
    assert.doesNotMatch(requests[1].body.query, /system rules/);
  });
});

test('HTTP E2E: tool_call_id is preserved and completed duplicate is replayed instead of re-emitted', async () => {
  const toolCall = { id: 'call-e2e-1', type: 'function', function: { name: 'lookup', arguments: '{"q":"abc"}' } };
  await withFakeDify(async (_body, index) => {
    if (index === 0) return { body: { conversation_id: 'conv-tool-e2e', answer: JSON.stringify({ tool_calls: [toolCall] }) } };
    if (index === 1) return { body: { conversation_id: 'conv-tool-e2e', answer: JSON.stringify({ tool_calls: [toolCall] }) } };
    return { body: { conversation_id: 'conv-tool-e2e', answer: 'final answer after replay' } };
  }, async ({ baseUrl, requests }) => {
    const id = 'e2e-tool-ledger';
    const tools = [{ type: 'function', function: { name: 'lookup', description: 'lookup', parameters: { type: 'object', properties: { q: { type: 'string' } } } } }];
    const first = await invoke({ baseUrl, dshConversationId: id, body: { tools, messages: [{ role: 'user', content: 'lookup abc' }] } });
    assert.equal(first.payload.choices[0].finish_reason, 'tool_calls');
    assert.equal(first.payload.choices[0].message.tool_calls[0].id, 'call-e2e-1');

    const second = await invoke({
      baseUrl,
      dshConversationId: id,
      body: {
        tools,
        messages: [
          { role: 'user', content: 'lookup abc' },
          { role: 'assistant', content: null, tool_calls: [toolCall] },
          { role: 'tool', tool_call_id: 'call-e2e-1', content: 'tool-result-123' },
        ],
      },
    });
    assert.equal(requests.length, 3);
    assert.equal(requests[1].body.conversation_id, 'conv-tool-e2e');
    assert.match(requests[1].body.query, /tool_call_id=call-e2e-1/);
    assert.match(requests[1].body.query, /tool-result-123/);
    assert.equal(requests[2].body.conversation_id, 'conv-tool-e2e');
    assert.match(requests[2].body.query, /tool_call_id=call-e2e-1/);
    assert.match(requests[2].body.query, /tool-result-123/);
    assert.equal(second.payload.choices[0].finish_reason, 'stop');
    assert.equal(second.payload.choices[0].message.content, 'final answer after replay');
    assert.equal(second.payload.choices[0].message.tool_calls, undefined);
  });
});

test('HTTP E2E: invalid remote conversation triggers one RECOVER bootstrap and saves the replacement id', async () => {
  await withFakeDify(async (body, index) => {
    if (index === 0) return { body: { conversation_id: 'conv-stale', answer: 'first' } };
    if (index === 1) return { status: 404, body: { message: 'conversation not found' } };
    if (index === 2) return { body: { conversation_id: 'conv-recovered', answer: 'recovered' } };
    return { body: { conversation_id: 'conv-recovered', answer: 'continued' } };
  }, async ({ baseUrl, requests }) => {
    const id = 'e2e-recover';
    await invoke({ baseUrl, dshConversationId: id, body: { messages: [{ role: 'user', content: 'old question' }] } });
    const recovered = await invoke({ baseUrl, dshConversationId: id, body: { messages: [{ role: 'user', content: 'old question' }, { role: 'assistant', content: 'first' }, { role: 'user', content: 'new question' }] } });
    assert.equal(recovered.statusCode, 200);
    assert.equal(requests[1].body.conversation_id, 'conv-stale');
    assert.equal(requests[2].body.conversation_id, '');
    assert.match(requests[2].body.query, /old question/);
    assert.match(requests[2].body.query, /new question/);

    await invoke({ baseUrl, dshConversationId: id, body: { messages: [{ role: 'user', content: 'after recovery' }] } });
    assert.equal(requests[3].body.conversation_id, 'conv-recovered');
  });
});

test('HTTP E2E: Dify app A and B keep independent remote conversations', async () => {
  await withFakeDify(async (_body, index) => {
    if (index === 0) return { body: { conversation_id: 'conv-app-a', answer: 'A' } };
    if (index === 1) return { body: { conversation_id: 'conv-app-b', answer: 'B' } };
    return { body: { conversation_id: 'conv-app-a', answer: 'A2' } };
  }, async ({ baseUrl, requests }) => {
    const id = 'e2e-provider-scope';
    await invoke({ baseUrl, dshConversationId: id, difyAppId: 'app-a', body: { messages: [{ role: 'user', content: 'A1' }] } });
    await invoke({ baseUrl, dshConversationId: id, difyAppId: 'app-b', body: { messages: [{ role: 'user', content: 'B1' }] } });
    await invoke({ baseUrl, dshConversationId: id, difyAppId: 'app-a', body: { messages: [{ role: 'user', content: 'A2' }] } });
    assert.equal(requests[0].body.conversation_id, '');
    assert.equal(requests[1].body.conversation_id, '');
    assert.equal(requests[2].body.conversation_id, 'conv-app-a');
  });
});
