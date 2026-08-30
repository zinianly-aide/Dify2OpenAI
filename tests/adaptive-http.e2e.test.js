import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

async function freePort() {
  const server = http.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function fakeDify(name) {
  const requests = [];
  let unavailable = false;
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    requests.push(body);
    if (unavailable) {
      res.statusCode = 503;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ message: `${name} unavailable` }));
      return;
    }
    const conversationId = body.conversation_id || `conv-${name}${requests.filter((x) => !x.conversation_id).length}`;
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      answer: `${name}-ok`,
      conversation_id: conversationId,
      metadata: { usage: { prompt_tokens: name === 'A' ? 12000 : 24000, completion_tokens: 8 } },
    }));
  });
  return {
    server,
    requests,
    setUnavailable(value) { unavailable = value; },
  };
}

async function waitReady(port, child) {
  for (let i = 0; i < 60; i += 1) {
    if (child.exitCode !== null) throw new Error(`gateway exited early: ${child.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/capabilities`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('adaptive gateway did not become ready');
}

async function chat(port, messages, extra = {}) {
  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer gateway-test',
      'x-session-id': 'session-A',
      'x-provider-id': 'gateway',
      ...extra.headers,
    },
    body: JSON.stringify({ model: 'adaptive', messages, stream: false, ...extra.body }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`gateway ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

test('HTTP E2E: affinity A migrates to larger Dify B, reuses B, then deterministically falls back without tool duplication', async (t) => {
  const a = fakeDify('A');
  const b = fakeDify('B');
  const aPort = await listen(a.server);
  const bPort = await listen(b.server);
  const gatewayPort = await freePort();
  t.after(async () => {
    await Promise.all([
      new Promise((resolve) => a.server.close(resolve)),
      new Promise((resolve) => b.server.close(resolve)),
    ]);
  });

  const backends = [
    {
      backendId: 'dify-a', providerType: 'dify', baseUrl: `http://127.0.0.1:${aPort}`, model: 'a', enabled: true,
      maxContextWindow: 32000, supportsTools: true, supportsVision: false, supportsStreaming: true, supportsReasoning: false,
      statefulContext: true, costTier: 'medium', priority: 10,
    },
    {
      backendId: 'dify-b', providerType: 'dify', baseUrl: `http://127.0.0.1:${bPort}`, model: 'b', enabled: true,
      maxContextWindow: 128000, supportsTools: true, supportsVision: true, supportsStreaming: true, supportsReasoning: true,
      statefulContext: true, costTier: 'high', priority: 20,
    },
  ];
  const child = spawn(process.execPath, ['app.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(gatewayPort), GATEWAY_BACKENDS_JSON: JSON.stringify(backends), DIFY_TELEMETRY_STDOUT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });
  await waitReady(gatewayPort, child);

  const caps = await (await fetch(`http://127.0.0.1:${gatewayPort}/capabilities`)).json();
  assert.equal(caps.deterministic_backend_routing, true);
  assert.equal(caps.adaptive_routing_configured, true);
  assert.equal(caps.ml_routing, false);

  const baseMessages = [{ role: 'user', content: 'start on backend A' }];
  await chat(gatewayPort, baseMessages, { body: { tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }] } });
  assert.equal(a.requests.length, 1);
  assert.equal(a.requests[0].conversation_id, '');
  assert.equal(b.requests.length, 0);
  const convA1 = a.requests[0].conversation_id || 'conv-A1';

  const largeText = `continue with portable context src/router.js ROUTE_SAFE ${'x'.repeat(140000)}`;
  await chat(gatewayPort, [{ role: 'user', content: largeText }], { body: { tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }] } });
  assert.equal(b.requests.length, 1);
  assert.equal(b.requests[0].conversation_id, '');
  assert.match(b.requests[0].query, /ROUTE_SAFE/);
  const convB1 = 'conv-B1';

  const toolMessages = [
    { role: 'user', content: 'use the completed tool result and continue' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call-123', type: 'function', function: { name: 'read_file', arguments: '{"path":"src/router.js"}' } }] },
    { role: 'tool', tool_call_id: 'call-123', content: 'tool-result-once' },
    { role: 'user', content: 'next round' },
  ];
  await chat(gatewayPort, toolMessages, { body: { tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }] } });
  assert.equal(b.requests.length, 2);
  assert.equal(b.requests[1].conversation_id, convB1);

  b.setUnavailable(true);
  await chat(gatewayPort, toolMessages, { body: { tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }] } });
  assert.equal(b.requests.length, 3);
  assert.equal(b.requests[2].conversation_id, convB1);
  assert.equal(a.requests.length, 2);
  assert.equal(a.requests[1].conversation_id, '');
  assert.match(a.requests[1].query, /tool-result-once/);
  assert.ok(!a.requests[1].query.includes('conv-B1'));
  assert.ok(!output.includes('tool-result-once'));
  assert.ok(!output.includes(largeText));
  assert.ok(!output.includes(convA1));
  assert.ok(!output.includes(convB1));
});
