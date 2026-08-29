import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { GatewayObserver } from '../lib/gateway/gateway-observer.js';
import { TelemetryCollector } from '../lib/gateway/telemetry-collector.js';

class MockResponse extends EventEmitter {
  constructor() {
    super();
    this.statusCode = 200;
    this.locals = {};
    this.chunks = [];
  }
  write(chunk) {
    this.chunks.push(chunk);
    return true;
  }
  json(payload) {
    this.payload = payload;
    this.emit('finish');
    return this;
  }
  end(chunk) {
    if (chunk) this.write(chunk);
    this.emit('finish');
  }
}

test('integration: SSE request produces sanitized decision event with latency and usage', async () => {
  const emitted = [];
  const telemetry = new TelemetryCollector({ sink: (payload) => emitted.push(payload) });
  const observer = new GatewayObserver({ telemetry });
  const req = {
    headers: {
      'user-agent': 'cline/3.2',
      'x-session-id': 'very-private-session-id',
      'x-context-window': '10000',
      authorization: 'Bearer never-log-this-key',
    },
    body: {
      model: 'dify|Chat|https://backend.internal/v1',
      messages: [
        { role: 'user', content: 'secret integration prompt' },
        { role: 'assistant', content: 'previous response' },
      ],
      tools: [{ type: 'function', function: { name: 'bash', description: 'run shell', parameters: { type: 'object', properties: { command: { type: 'string' } } } } }],
    },
  };
  const res = new MockResponse();
  const observed = observer.observe(req, res, {
    traceId: 'trace-integration-1',
    providerId: 'dify',
    difyApiUrl: 'https://backend.internal/v1',
  });

  assert.equal(observed.decision.compression, 'none');
  assert.ok(observed.decision.reasonCodes.includes('client=cline'));
  res.write(`data: ${JSON.stringify({ id: 'x', choices: [{ delta: { content: 'hello' } }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ id: 'x', choices: [], usage: { prompt_tokens: 123, completion_tokens: 7, total_tokens: 130 } })}\n\n`);
  res.end('data: [DONE]\n\n');

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(emitted.length, 1);
  const { event, telemetry: record } = emitted[0];
  assert.equal(event.traceId, 'trace-integration-1');
  assert.equal(event.clientType, 'cline');
  assert.equal(event.result.success, true);
  assert.equal(event.result.promptTokens, 123);
  assert.equal(event.result.completionTokens, 7);
  assert.ok(event.result.firstTokenLatencyMs >= 0);
  assert.ok(event.result.latencyMs >= event.result.firstTokenLatencyMs);
  assert.equal(event.decision.compression, 'none');
  assert.ok(event.decision.reasonCodes.some((code) => code.startsWith('context_utilization=')));
  assert.equal(record.providerId, 'dify');
  assert.equal(record.completionTokens, 7);
  assert.equal(record.success, true);
  assert.match(record.backendId, /^dify-[a-f0-9]{12}$/);

  const serialized = JSON.stringify(emitted[0]);
  for (const forbidden of [
    'very-private-session-id',
    'never-log-this-key',
    'secret integration prompt',
    'previous response',
    'backend.internal',
  ]) assert.equal(serialized.includes(forbidden), false, `telemetry leaked ${forbidden}`);
});
