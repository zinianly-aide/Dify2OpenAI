import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { stableCanaryBucket } from '../packages/dify-core/index.js';

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

function findSession(version, predicate, prefix) {
  for (let i = 0; i < 100000; i += 1) {
    const session = `${prefix}-${i}`;
    if (predicate(stableCanaryBucket(session, version))) return session;
  }
  throw new Error('SESSION_BUCKET_NOT_FOUND');
}

function fakeDify(name) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    const entry = { body, authorization: String(req.headers.authorization || '') };
    requests.push(entry);
    const query = String(body.query || '');
    if (name === 'B' && query.includes('PRUNE_TRIGGER') && query.includes('tool_1') && !query.includes('tool_2')) {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ message: 'missing required tool tool_2' }));
      return;
    }
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      answer: `${name}-ok`,
      conversation_id: body.conversation_id || `conv-${name}-SENSITIVE-CONVERSATION-${requests.length}`,
      metadata: { usage: { prompt_tokens: 3600, completion_tokens: 12 } },
    }));
  });
  return { server, requests };
}

async function waitReady(port, child) {
  for (let i = 0; i < 100; i += 1) {
    if (child.exitCode !== null) throw new Error(`gateway exited early ${child.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/capabilities`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error('gateway readiness timeout');
}

async function chat(port, sessionId, body, headers = {}) {
  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer SENSITIVE-GATEWAY-API-KEY',
      'x-session-id': sessionId,
      'x-provider-id': 'gateway',
      'x-context-window': '10000',
      ...headers,
    },
    body: JSON.stringify({ model: 'adaptive', stream: false, ...body }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`gateway ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

function telemetryRecords(output) {
  const records = [];
  for (const line of output.split(/\r?\n/)) {
    const text = line.trim();
    if (!text.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(text);
      if (parsed.component === 'gateway-decision' && parsed.telemetry) records.push(parsed.telemetry);
    } catch {}
  }
  return records;
}

async function waitForTelemetry(getOutput, minimum) {
  for (let i = 0; i < 80; i += 1) {
    const records = telemetryRecords(getOutput());
    if (records.length >= minimum) return records;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`telemetry timeout, expected ${minimum}, got ${telemetryRecords(getOutput()).length}`);
}

function tool(name, secret = '') {
  return {
    type: 'function',
    function: {
      name,
      description: `${name} description ${secret}`,
      parameters: { type: 'object', properties: { value: { type: 'string', description: secret } } },
    },
  };
}

function warmupMessages(marker, secretArgument, secretResult) {
  return [
    { role: 'user', content: `${marker} warm up tool history` },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call-history-1', type: 'function', function: { name: 'tool_1', arguments: JSON.stringify({ value: secretArgument }) } }] },
    { role: 'tool', tool_call_id: 'call-history-1', content: secretResult },
    { role: 'user', content: `${marker} continue` },
  ];
}

test('production HTTP policy runtime applies canary config end-to-end with stable assignment and private telemetry', async (t) => {
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
      maxContextWindow: 128000, supportsTools: true, supportsVision: true, supportsStreaming: true, supportsReasoning: true,
      statefulContext: true, costTier: 'medium', priority: 10, apiKeyEnv: 'BACKEND_SECRET_KEY',
    },
    {
      backendId: 'dify-b', providerType: 'dify', baseUrl: `http://127.0.0.1:${bPort}`, model: 'b', enabled: true,
      maxContextWindow: 128000, supportsTools: true, supportsVision: true, supportsStreaming: true, supportsReasoning: true,
      statefulContext: true, costTier: 'medium', priority: 20, apiKeyEnv: 'BACKEND_SECRET_KEY',
    },
  ];
  const policies = [
    {
      policyVersion: 'v1', basePolicyVersion: null, candidateId: null, status: 'ACTIVE',
      config: { tool: { pruningConfidenceThreshold: 0.90, recoveryLimit: 1 } },
      createdAt: '2026-08-30T04:00:00.000Z', activatedAt: '2026-08-30T04:00:00.000Z', rollbackOf: null,
      evidence: { source: 'production-e2e' },
    },
    {
      policyVersion: 'v2', basePolicyVersion: 'v1', candidateId: 'candidate-v2', status: 'CANARY_5',
      config: {
        compression: { toolPruneThreshold: 0.10, lightThreshold: 0.20, heavyThreshold: 0.40, forceThreshold: 0.80 },
        checkpoint: { backendContextUtilizationThreshold: 0.50, amplificationThreshold: 1.10 },
        backendPriority: { 'dify-a': 50, 'dify-b': 1 },
        backendHealth: { minimumSamples: 1, unavailableConsecutiveFailures: 1, degradedFailureRate: 0.10, unavailableFailureRate: 0.20 },
        tool: { pruningConfidenceThreshold: 0.70, recoveryLimit: 0 },
      },
      createdAt: '2026-08-30T04:10:00.000Z', activatedAt: null, rollbackOf: null,
      evidence: { replayEvaluation: 'ACCEPT_FOR_CANARY' }, stageEnteredAt: '2026-08-30T04:10:00.000Z',
    },
  ];

  const child = spawn(process.execPath, ['app.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(gatewayPort),
      GATEWAY_BACKENDS_JSON: JSON.stringify(backends),
      GATEWAY_POLICIES_JSON: JSON.stringify(policies),
      BACKEND_SECRET_KEY: 'SENSITIVE-BACKEND-API-KEY',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });
  await waitReady(gatewayPort, child);

  const caps = await (await fetch(`http://127.0.0.1:${gatewayPort}/capabilities`)).json();
  assert.equal(caps.policy_runtime_configured, true);
  assert.equal(caps.stable_canary_assignment, true);
  assert.equal(caps.ml_routing, false);

  const canarySession = findSession('v2', (bucket) => bucket < 5, 'RAW-SESSION-ID-SECRET-CANARY');
  const secondCanarySession = findSession('v2', (bucket) => bucket < 5, 'RAW-SESSION-ID-SECRET-CANARY-HEALTH');
  const baselineSession = findSession('v2', (bucket) => bucket >= 5, 'RAW-SESSION-ID-SECRET-BASELINE');
  assert.equal(stableCanaryBucket(canarySession, 'v2'), stableCanaryBucket(canarySession, 'v2'));

  const sensitivePrompt = `SENSITIVE-RAW-PROMPT ${'x'.repeat(8000)}`;
  const baselineResponse = await chat(gatewayPort, baselineSession, { messages: [{ role: 'user', content: sensitivePrompt }] });
  const canaryResponse = await chat(gatewayPort, canarySession, { messages: [{ role: 'user', content: sensitivePrompt }] });
  assert.equal(baselineResponse.model, 'dify-a');
  assert.equal(canaryResponse.model, 'dify-b');
  let records = await waitForTelemetry(() => output, 2);
  const baselineTelemetry = records.find((r) => r.policy_version === 'v1');
  const canaryTelemetry = records.find((r) => r.policy_version === 'v2');
  assert.ok(baselineTelemetry);
  assert.ok(canaryTelemetry);
  assert.equal(baselineTelemetry.policy_assignment, 'ACTIVE_BASELINE');
  assert.equal(canaryTelemetry.policy_assignment, 'CANARY');
  assert.equal(canaryTelemetry.canary_stage, 'CANARY_5');
  assert.equal(canaryTelemetry.canary_bucket, stableCanaryBucket(canarySession, 'v2'));
  assert.equal(baselineTelemetry.compressionMode, 'none');
  assert.notEqual(canaryTelemetry.compressionMode, 'none');
  assert.equal(baselineTelemetry.checkpointRecommended, false);
  assert.equal(canaryTelemetry.checkpointRecommended, true);

  const schemaSecret = 'SENSITIVE-RAW-TOOL-SCHEMA';
  const argumentSecret = 'SENSITIVE-RAW-TOOL-ARGUMENT';
  const resultSecret = 'SENSITIVE-RAW-TOOL-RESULT';
  const tools = [tool('tool_1', schemaSecret), tool('tool_2', schemaSecret)];

  await chat(gatewayPort, baselineSession, { messages: warmupMessages('BASELINE_WARMUP', argumentSecret, resultSecret), tools });
  await chat(gatewayPort, canarySession, { messages: warmupMessages('CANARY_WARMUP', argumentSecret, resultSecret), tools });
  const baselineBefore = a.requests.length;
  const bBefore = b.requests.length;
  await chat(gatewayPort, baselineSession, { messages: [{ role: 'user', content: 'PRUNE_TRIGGER baseline' }], tools });
  const candidatePruneResponse = await chat(gatewayPort, canarySession, { messages: [{ role: 'user', content: 'PRUNE_TRIGGER candidate' }], tools });
  assert.equal(candidatePruneResponse.model, 'dify-a');
  const baselinePruneRequests = a.requests.slice(baselineBefore).filter((r) => String(r.body.query).includes('PRUNE_TRIGGER baseline'));
  assert.equal(baselinePruneRequests.length, 1);
  assert.match(baselinePruneRequests[0].body.query, /tool_1/);
  assert.match(baselinePruneRequests[0].body.query, /tool_2/);
  const candidateBPruneRequests = b.requests.slice(bBefore).filter((r) => String(r.body.query).includes('PRUNE_TRIGGER candidate'));
  assert.equal(candidateBPruneRequests.length, 1, 'recoveryLimit=0 must not retry pruned request on candidate backend');
  assert.match(candidateBPruneRequests[0].body.query, /tool_1/);
  assert.doesNotMatch(candidateBPruneRequests[0].body.query, /tool_2/);
  const candidateFallback = a.requests.find((r) => String(r.body.query).includes('PRUNE_TRIGGER candidate'));
  assert.ok(candidateFallback, 'candidate request should fall back after missing-tool 5xx');

  const bAfterFailure = b.requests.length;
  const healthResponse = await chat(gatewayPort, secondCanarySession, { messages: [{ role: 'user', content: 'HEALTH_THRESHOLD_CHECK' }] });
  assert.equal(healthResponse.model, 'dify-a');
  assert.equal(b.requests.length, bAfterFailure, 'candidate health threshold should mark B unavailable after one consecutive failure');

  for (let i = 0; i < 4; i += 1) {
    await chat(gatewayPort, canarySession, { messages: [{ role: 'user', content: `STABLE_ASSIGNMENT_ROUND_${i}` }] });
  }
  records = await waitForTelemetry(() => output, 11);
  const stableRecords = records.filter((r) => r.policy_version === 'v2' && r.canary_bucket === stableCanaryBucket(canarySession, 'v2'));
  assert.ok(stableRecords.length >= 4);
  assert.ok(stableRecords.every((r) => r.policy_assignment === 'CANARY' && r.canary_stage === 'CANARY_5'));

  assert.ok(a.requests.some((r) => r.authorization === 'Bearer SENSITIVE-BACKEND-API-KEY'));
  assert.ok(b.requests.some((r) => r.authorization === 'Bearer SENSITIVE-BACKEND-API-KEY'));
  const serializedTelemetry = JSON.stringify(records);
  for (const secret of [
    canarySession,
    baselineSession,
    secondCanarySession,
    'SENSITIVE-CONVERSATION',
    'SENSITIVE-RAW-PROMPT',
    schemaSecret,
    argumentSecret,
    resultSecret,
    'SENSITIVE-GATEWAY-API-KEY',
    'SENSITIVE-BACKEND-API-KEY',
  ]) assert.equal(serializedTelemetry.includes(secret), false, `telemetry leaked ${secret}`);

  assert.ok(records.some((r) => r.policy_version === 'v2'));
  assert.ok(records.every((r) => !('rawSessionId' in r) && !('conversationId' in r) && !('rawPrompt' in r) && !('toolArguments' in r) && !('toolResult' in r) && !('apiKey' in r)));
});
