import test from 'node:test';
import assert from 'node:assert/strict';
import { CanonicalRequest, detectClientType } from '../lib/gateway/canonical.js';
import { ContextProfiler } from '../lib/gateway/context-profiler.js';
import { DecisionEngine } from '../lib/gateway/decision-engine.js';
import { TelemetryCollector } from '../lib/gateway/telemetry-collector.js';

test('canonical request is metadata-only and hashes session identity', () => {
  const req = {
    headers: {
      'user-agent': 'codex-cli/1.0',
      'x-session-id': 'secret-session-123',
      authorization: 'Bearer super-secret-api-key',
    },
    body: {
      model: 'dify|Chat|https://sensitive.example/v1',
      messages: [
        { role: 'user', content: 'PRIVATE PROMPT CONTENT' },
        { role: 'tool', tool_call_id: 'call-1', content: 'PRIVATE TOOL RESULT' },
      ],
      tools: [{ type: 'function', function: { name: 'shell', description: 'run', parameters: { type: 'object' } } }],
    },
  };
  const canonical = CanonicalRequest.fromExpress(req, {
    traceId: 'trace-1',
    providerId: 'dify',
    backendId: 'backend-a',
    contextWindow: 4096,
  });
  assert.equal(canonical.clientType, 'codex');
  assert.equal(canonical.model, 'dify');
  assert.equal(canonical.messageCount, 2);
  assert.equal(canonical.toolCount, 1);
  assert.ok(canonical.sessionIdHash);
  assert.notEqual(canonical.sessionIdHash, 'secret-session-123');
  assert.ok(canonical.estimatedPromptTokens > 0);
  assert.ok(canonical.toolSchemaEstimatedTokens > 0);
  const serialized = JSON.stringify(canonical);
  assert.equal(serialized.includes('PRIVATE PROMPT CONTENT'), false);
  assert.equal(serialized.includes('PRIVATE TOOL RESULT'), false);
  assert.equal(serialized.includes('secret-session-123'), false);
  assert.equal(serialized.includes('super-secret-api-key'), false);
  assert.equal(serialized.includes('sensitive.example'), false);
});

test('client classification covers DSH OpenCode Cline and Codex without changing request shape', () => {
  const cases = [
    [{ headers: { 'user-agent': 'deepseek-harness/0.1' }, body: {} }, 'dsh'],
    [{ headers: { 'user-agent': 'opencode/1.2.3' }, body: {} }, 'opencode'],
    [{ headers: { 'user-agent': 'cline/3.2' }, body: {} }, 'cline'],
    [{ headers: { 'user-agent': 'codex-cli/1.0' }, body: {} }, 'codex'],
  ];
  for (const [req, expected] of cases) assert.equal(detectClientType(req), expected);
});

test('decision engine emits deterministic policy-driven compression reasons', () => {
  const req = { headers: { 'x-client-type': 'cline' }, body: { messages: [{ role: 'user', content: 'hello' }], tools: [] } };
  const canonical = CanonicalRequest.fromExpress(req, { traceId: 'trace-2', backendId: 'backend-b', contextWindow: 100 });
  const profile = new ContextProfiler().profile(canonical);
  const decision = new DecisionEngine().decide(canonical, profile);
  assert.equal(decision.compression, 'none');
  assert.ok(decision.reasonCodes.length >= 4);
  assert.ok(decision.reasonCodes.includes('client=cline'));
  assert.ok(decision.reasonCodes.includes('policy=context_compression_v1'));
  assert.ok(decision.reasonCodes.includes('compression_mode=none'));
});

test('telemetry collector emits complete sanitized record and GatewayDecisionEvent', () => {
  const req = { headers: { 'x-session-id': 'raw-session' }, body: { model: 'dify', messages: [{ role: 'user', content: 'do not persist me' }], tools: [] } };
  const canonical = CanonicalRequest.fromExpress(req, { traceId: 'trace-3', providerId: 'dify', backendId: 'backend-c', contextWindow: 8192 });
  const profile = new ContextProfiler().profile(canonical);
  const decision = new DecisionEngine().decide(canonical, profile);
  const emitted = [];
  const collector = new TelemetryCollector({ sink: (payload) => emitted.push(payload) });
  const { event, telemetry } = collector.collect(canonical, decision, {
    success: true,
    latencyMs: 120,
    firstTokenLatencyMs: 30,
    promptTokens: 10,
    completionTokens: 4,
    retryCount: 1,
  });
  assert.equal(event.traceId, 'trace-3');
  assert.equal(event.result.success, true);
  assert.equal(event.result.completionTokens, 4);
  assert.equal(event.decision.compression, 'none');
  assert.ok(event.decision.reasonCodes.length > 0);
  assert.equal(telemetry.providerId, 'dify');
  assert.equal(telemetry.backendId, 'backend-c');
  assert.equal(telemetry.completionTokens, 4);
  assert.equal(telemetry.retryCount, 1);
  assert.equal(telemetry.compressionMode, 'none');
  assert.equal(emitted.length, 1);
  const serialized = JSON.stringify(emitted[0]);
  assert.equal(serialized.includes('raw-session'), false);
  assert.equal(serialized.includes('do not persist me'), false);
});
