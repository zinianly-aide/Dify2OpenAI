import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { GatewayObserver } from '../lib/gateway/gateway-observer.js';
import { getPolicyRuntime, resetPolicyRuntimeForTests } from '../lib/policy-runtime.js';
import { stableCanaryBucket } from '../packages/dify-core/index.js';

function findCanarySession(version) {
  for (let i = 0; i < 50000; i += 1) {
    const session = `telemetry-session-${i}`;
    if (stableCanaryBucket(session, version) < 5) return session;
  }
  throw new Error('CANARY_SESSION_NOT_FOUND');
}

class FakeResponse extends EventEmitter {
  constructor(locals = {}) {
    super();
    this.locals = locals;
    this.statusCode = 200;
  }
  write() { return true; }
  json(payload) { this.payload = payload; return payload; }
}

test('policy telemetry write failure never fails production response and blocks canary to stable ACTIVE', () => {
  const previous = process.env.GATEWAY_POLICIES_JSON;
  const policies = [
    { policyVersion: 'v1', basePolicyVersion: null, candidateId: null, status: 'ACTIVE', config: {}, createdAt: '2026-08-30T04:00:00.000Z', activatedAt: '2026-08-30T04:00:00.000Z', rollbackOf: null, evidence: {} },
    { policyVersion: 'v2', basePolicyVersion: 'v1', candidateId: 'candidate-v2', status: 'CANARY_5', config: {}, createdAt: '2026-08-30T04:10:00.000Z', activatedAt: null, rollbackOf: null, evidence: {}, stageEnteredAt: '2026-08-30T04:10:00.000Z' },
  ];
  process.env.GATEWAY_POLICIES_JSON = JSON.stringify(policies);
  resetPolicyRuntimeForTests();
  try {
    const runtime = getPolicyRuntime();
    const sessionId = findCanarySession('v2');
    const selected = runtime.controlPlane.selectPolicy({ sessionId });
    assert.equal(selected.selectedPolicyVersion, 'v2');

    const telemetry = { collect() { throw new Error('TELEMETRY_SINK_UNAVAILABLE'); } };
    const observer = new GatewayObserver({ telemetry });
    const req = {
      headers: { 'x-session-id': sessionId, 'x-context-window': '10000', 'x-provider-id': 'gateway' },
      body: { model: 'adaptive', messages: [{ role: 'user', content: 'safe request' }], tools: [] },
    };
    const res = new FakeResponse({ gatewayPolicySelection: selected });
    observer.observe(req, res, { traceId: 'trace-telemetry-failure', providerId: 'gateway', backendId: 'adaptive-router' });
    res.json({ choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 10, completion_tokens: 2 } });
    assert.doesNotThrow(() => res.emit('finish'));
    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.choices[0].message.content, 'ok');

    const afterFailure = runtime.controlPlane.selectPolicy({ sessionId });
    assert.equal(afterFailure.selectedPolicyVersion, 'v1');
    assert.equal(afterFailure.policyAssignment, 'STABLE_ACTIVE_FAIL_OPEN');
    assert.match(afterFailure.selectionFallbackReason, /TELEMETRY_UNAVAILABLE/);
  } finally {
    if (previous === undefined) delete process.env.GATEWAY_POLICIES_JSON;
    else process.env.GATEWAY_POLICIES_JSON = previous;
    resetPolicyRuntimeForTests();
  }
});
