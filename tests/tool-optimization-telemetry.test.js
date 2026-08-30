import test from 'node:test';
import assert from 'node:assert/strict';
import { createTelemetryRecord } from '../packages/dify-core/index.js';

test('tool optimization telemetry exposes only sanitized counts decisions and recovery metadata', () => {
  const canonicalRequest = {
    traceId: 'trace-tool', clientType: 'dsh', sessionIdHash: 'hashed-session', providerId: 'gateway', backendId: 'b',
    estimatedPromptTokens: 1000, contextWindow: 32000, contextUtilization: 0.03, messageCount: 2, toolCount: 25,
    toolSchemaEstimatedTokens: 3000, policyVersion: 'deterministic-backend-router-v1',
  };
  const decision = { backendId: 'b', model: 'm', compression: 'none', policyVersion: 'deterministic-backend-router-v1' };
  const result = {
    success: true,
    toolOptimization: {
      beforeToolCount: 25,
      afterToolCount: 4,
      beforeSchemaTokens: 3000,
      afterSchemaTokens: 600,
      savedTokens: 2400,
      mode: 'PRUNED',
      confidence: 'high',
      reasonCodes: ['DETERMINISTIC_RELEVANCE_PRUNE'],
      recoveryTriggered: true,
      recoveryReason: 'MISSING_TOOL',
      recoverySuccess: true,
      schemaHash: 'safe-hash-only',
      rawSchema: 'SECRET_SCHEMA_SHOULD_NOT_APPEAR',
      arguments: '{"secret":true}',
      result: 'SECRET_TOOL_RESULT',
    },
  };
  const telemetry = createTelemetryRecord(canonicalRequest, decision, result);
  assert.equal(telemetry.tool_count_before, 25);
  assert.equal(telemetry.tool_count_after, 4);
  assert.equal(telemetry.tool_schema_tokens_before, 3000);
  assert.equal(telemetry.tool_schema_tokens_after, 600);
  assert.equal(telemetry.tool_schema_tokens_saved, 2400);
  assert.equal(telemetry.tool_pruning_mode, 'PRUNED');
  assert.equal(telemetry.tool_pruning_confidence, 'high');
  assert.deepEqual(telemetry.tool_pruning_reason_codes, ['DETERMINISTIC_RELEVANCE_PRUNE']);
  assert.equal(telemetry.tool_recovery_triggered, true);
  assert.equal(telemetry.tool_recovery_reason, 'MISSING_TOOL');
  assert.equal(telemetry.tool_recovery_success, true);
  const serialized = JSON.stringify(telemetry);
  assert.equal(serialized.includes('SECRET_SCHEMA_SHOULD_NOT_APPEAR'), false);
  assert.equal(serialized.includes('secret'), false);
  assert.equal(serialized.includes('SECRET_TOOL_RESULT'), false);
  assert.equal(serialized.includes('safe-hash-only'), false);
});
