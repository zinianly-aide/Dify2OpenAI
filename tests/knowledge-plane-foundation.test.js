import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ExperienceCompiler,
  GatewayKnowledgeStore,
  KnowledgeScope,
  assertKnowledgePrivacy,
} from '../packages/dify-core/index.js';

const compiler = new ExperienceCompiler();

function event(overrides = {}) {
  return {
    timestamp: '2026-08-31T00:00:00.000Z',
    traceId: 'trace-secret',
    sessionIdHash: 'already-hashed-session-a',
    rawPrompt: 'must disappear',
    conversationId: 'conv-secret',
    toolArguments: { file: '/secret.png' },
    toolResult: 'secret result',
    apiKey: 'secret-key',
    attachmentContent: 'secret-bytes',
    clientType: 'dsh',
    taskType: 'tool-use',
    backendType: 'dify',
    backendId: 'private-backend-id',
    model: 'qwen-3.5',
    contextUtilization: 0.8,
    contextAmplification: 1.4,
    compressionMode: 'light',
    checkpointCreated: true,
    rotationOccurred: false,
    toolCountBefore: 20,
    toolCountAfter: 8,
    toolSchemaTokensSaved: 1200,
    toolPruningConfidence: 'high',
    toolRecoveryTriggered: false,
    migrationOccurred: false,
    fallbackUsed: false,
    routingReasonCodes: ['SESSION_AFFINITY'],
    backendPromptTokens: 6000,
    latencyMs: 800,
    estimatedCost: 0.004,
    success: true,
    policyVersion: 'v2',
    ...overrides,
  };
}

test('same event produces same experienceId', () => {
  assert.equal(compiler.compile(event()).experienceId, compiler.compile(event()).experienceId);
});

test('different sessions remain anonymous and do not affect identity', () => {
  const a = compiler.compile(event({ sessionIdHash: 'hash-a', rawSessionId: 'raw-a' }));
  const b = compiler.compile(event({ sessionIdHash: 'hash-b', rawSessionId: 'raw-b' }));
  assert.equal(a.experienceId, b.experienceId);
  assert.equal(JSON.stringify(a).includes('raw-a'), false);
  assert.equal(JSON.stringify(b).includes('hash-b'), false);
});

test('scope classification reflects semantic dependency rather than environment metadata', () => {
  assert.equal(compiler.compile(event()).scope, KnowledgeScope.GENERAL);
  assert.equal(compiler.compile(event({ backendSpecific: true })).scope, KnowledgeScope.BACKEND_SPECIFIC);
  assert.equal(compiler.compile(event({ clientSpecific: true })).scope, KnowledgeScope.CLIENT_SPECIFIC);
  assert.equal(compiler.compile(event({ modelSpecific: true })).scope, KnowledgeScope.MODEL_SPECIFIC);
  assert.equal(compiler.compile(event({ versionSpecific: true })).scope, KnowledgeScope.VERSION_SPECIFIC);
});

test('strict whitelist removes sensitive fields and innocent-key payloads by value', () => {
  const secrets = [
    'raw prompt value',
    'raw-session-123',
    'raw-conversation-456',
    'sk-live-secret-value',
    '{"path":"/private/file"}',
    'tool returned private data',
    'attachment-binary-secret',
  ];
  const experience = compiler.compile(event({
    message: secrets[0],
    note: secrets[1],
    payload: { conversation: secrets[2], api: secrets[3] },
    metadata: { args: secrets[4], result: secrets[5], bytes: secrets[6] },
  }));
  const store = new GatewayKnowledgeStore();
  store.appendExperience(experience);
  const snapshot = store.createSnapshot();
  assert.doesNotThrow(() => assertKnowledgePrivacy(experience));
  assert.doesNotThrow(() => assertKnowledgePrivacy(snapshot));
  const serialized = JSON.stringify(snapshot);
  for (const secret of [...secrets, 'must disappear', 'conv-secret', '/secret.png', 'secret result', 'secret-key', 'secret-bytes', 'trace-secret', 'already-hashed-session-a']) {
    assert.equal(serialized.includes(secret), false, `leaked ${secret}`);
  }
  for (const key of ['message', 'note', 'payload', 'metadata']) assert.equal(key in experience, false);
});

test('same dataset produces same snapshotId regardless append order', () => {
  const a = compiler.compile(event());
  const b = compiler.compile(event({ timestamp: '2026-08-31T00:01:00.000Z', taskType: 'chat' }));
  const first = new GatewayKnowledgeStore();
  first.appendExperience(a); first.appendExperience(b);
  const second = new GatewayKnowledgeStore();
  second.appendExperience(b); second.appendExperience(a);
  assert.equal(first.createSnapshot().snapshotId, second.createSnapshot().snapshotId);
});

test('DecisionEvent can compile to experience', () => {
  const experience = compiler.compile(event(), { sourceType: 'DecisionEvent', sourceId: 'decision-1' });
  assert.equal(experience.source.type, 'DecisionEvent');
  assert.match(experience.source.idHash, /^[a-f0-9]{16}$/);
});

test('tool recovery event can compile', () => {
  assert.equal(compiler.compile(event({ toolRecoveryTriggered: true })).tools.recoveryTriggered, true);
});

test('rotation event can compile', () => {
  assert.equal(compiler.compile(event({ rotationOccurred: true })).context.rotation, true);
});

test('routing fallback event can compile', () => {
  const experience = compiler.compile(event({ migrationOccurred: true, fallbackUsed: true, routingReasonCodes: ['BACKEND_UNAVAILABLE'] }));
  assert.equal(experience.routing.migration, true);
  assert.equal(experience.routing.fallback, true);
  assert.deepEqual(experience.routing.reasonCodes, ['BACKEND_UNAVAILABLE']);
});

test('knowledge models and snapshots are immutable', () => {
  const experience = compiler.compile(event());
  const store = new GatewayKnowledgeStore();
  store.appendExperience(experience);
  const snapshot = store.createSnapshot();
  assert.equal(Object.isFrozen(experience), true);
  assert.equal(Object.isFrozen(experience.context), true);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.experiences), true);
});
