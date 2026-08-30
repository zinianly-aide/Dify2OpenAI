import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BackendUsageExtractor,
  CheckpointRecommendation,
  DifyUsageExtractor,
  GenericOpenAIUsageExtractor,
  reconcileBackendContext,
} from '../packages/dify-core/index.js';

test('gateway 30k and backend 30k yields amplification 1.0', () => {
  const reconciled = reconcileBackendContext({
    gatewayEstimatedInputTokens: 50000,
    gatewayCompressedTokens: 30000,
    backendPromptTokens: 30000,
    backendCompletionTokens: 1000,
  });
  assert.equal(reconciled.gatewayCompressedTokens, 30000);
  assert.equal(reconciled.backendPromptTokens, 30000);
  assert.equal(reconciled.contextAmplification, 1);
});

test('gateway 30k and backend 90k yields amplification 3.0', () => {
  const reconciled = reconcileBackendContext({
    gatewayEstimatedInputTokens: 50000,
    gatewayCompressedTokens: 30000,
    backendPromptTokens: 90000,
  });
  assert.equal(reconciled.contextAmplification, 3);
});

test('backend usage unavailable stays unknown and never uses gateway estimate as actual usage', () => {
  const reconciled = reconcileBackendContext({
    gatewayEstimatedInputTokens: 50000,
    gatewayCompressedTokens: 30000,
  });
  assert.equal(reconciled.backendPromptTokens, undefined);
  assert.equal(reconciled.contextAmplification, undefined);
});

test('generic and Dify usage extractors return only reported backend usage', () => {
  const generic = new GenericOpenAIUsageExtractor();
  const dify = new DifyUsageExtractor();
  const aggregate = new BackendUsageExtractor();
  assert.deepEqual(generic.extract({ usage: { prompt_tokens: 30, completion_tokens: 4 } }), { backendPromptTokens: 30, backendCompletionTokens: 4 });
  assert.deepEqual(dify.extract({ metadata: { usage: { prompt_tokens: 90, completion_tokens: 5 } } }), { backendPromptTokens: 90, backendCompletionTokens: 5 });
  assert.deepEqual(aggregate.extract({ usage: { input_tokens: 7, output_tokens: 2 } }), { backendPromptTokens: 7, backendCompletionTokens: 2 });
  assert.equal(dify.extract({ metadata: {} }), undefined);
});

test('unableToReachTarget recommends checkpoint without executing it', () => {
  const recommendation = new CheckpointRecommendation().recommend({
    compressionResult: { unableToReachTarget: true },
    reconciliation: { gatewayCompressedTokens: 30000 },
  });
  assert.equal(recommendation.recommended, true);
  assert.ok(recommendation.reasonCodes.includes('compression_target_unreachable'));
});

test('high amplification recommends checkpoint', () => {
  const recommendation = new CheckpointRecommendation({ config: { amplificationThreshold: 2, backendContextUtilizationThreshold: 0.9 } }).recommend({
    compressionResult: { unableToReachTarget: false },
    reconciliation: { contextAmplification: 3 },
  });
  assert.equal(recommendation.recommended, true);
  assert.ok(recommendation.reasonCodes.includes('backend_context_amplification_high'));
});

test('healthy context does not recommend checkpoint', () => {
  const recommendation = new CheckpointRecommendation().recommend({
    compressionResult: { unableToReachTarget: false },
    reconciliation: { contextAmplification: 1, backendContextUtilization: 0.4 },
  });
  assert.deepEqual(recommendation, { recommended: false, reasonCodes: [] });
});
