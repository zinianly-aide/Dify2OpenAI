import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CanonicalRequest,
  CanonicalResponse,
  DecisionEngine,
  TelemetryCollector,
} from '../packages/dify-core/index.js';

test('rotation telemetry exposes only sanitized ids and generation metadata', () => {
  const rawSession = 'raw-session-must-never-appear';
  const rawOldConversation = 'conv-raw-old-secret';
  const rawNewConversation = 'conv-raw-new-secret';
  const req = CanonicalRequest.fromDsh({
    provider: 'dify',
    model: 'app',
    sessionId: rawSession,
    messages: [{ role: 'user', content: 'private checkpoint prompt' }],
    tools: [],
  }, { traceId: 'rotation-trace', backendId: 'dify-test', contextWindow: 100000 });
  const decision = new DecisionEngine().decide(req, {
    ...req,
    utilizationBand: 'low',
  }, { backendId: 'dify-test', model: 'app' });
  let emitted;
  const collector = new TelemetryCollector({ sink: (payload) => { emitted = payload; } });
  collector.collect(req, decision, new CanonicalResponse({
    success: true,
    latencyMs: 10,
    compressionResult: {
      mode: 'heavy', beforeTokens: 90000, afterTokens: 30000, savedTokens: 60000,
      compressionPasses: 2, targetReached: false, unableToReachTarget: true,
      preservedRecentTurns: 3, reasonCodes: ['MAX_PASSES_REACHED'],
    },
    checkpointRecommendation: { recommended: true, reasonCodes: ['compression_target_unreachable'] },
    rotation: {
      checkpointCreated: true,
      sourceGeneration: 1,
      targetGeneration: 2,
      rotationStarted: true,
      rotationSuccess: true,
      checkpointBeforeTokens: 90000,
      checkpointAfterTokens: 28000,
      oldConversationIdHash: 'old-hash-only',
      newConversationIdHash: 'new-hash-only',
      backendContextReductionPct: 66.6666666667,
    },
  }));

  assert.equal(emitted.telemetry.checkpoint_created, true);
  assert.equal(emitted.telemetry.source_generation, 1);
  assert.equal(emitted.telemetry.target_generation, 2);
  assert.equal(emitted.telemetry.rotation_started, true);
  assert.equal(emitted.telemetry.rotation_success, true);
  assert.equal(emitted.telemetry.backend_context_reduction_pct, 66.6666666667);
  assert.equal(emitted.event.rotation.rotationSuccess, true);
  const serialized = JSON.stringify(emitted);
  for (const forbidden of [rawSession, rawOldConversation, rawNewConversation, 'private checkpoint prompt']) {
    assert.equal(serialized.includes(forbidden), false, `rotation telemetry leaked ${forbidden}`);
  }
});
