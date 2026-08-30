import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BackendProviderType,
  CanonicalRequest,
  createTelemetryRecord,
} from '../packages/dify-core/index.js';
import {
  backendCredentialResolverFromEnv,
  createBackendRegistryFromEnv,
} from '../lib/backend-registry-config.js';

test('backend registry keeps credential env reference but never stores secret value', () => {
  const env = {
    BACKEND_A_KEY: 'secret-backend-key',
    GATEWAY_BACKENDS_JSON: JSON.stringify([{
      backendId: 'dify-a',
      providerType: BackendProviderType.DIFY,
      baseUrl: 'https://example.invalid/v1',
      model: 'a',
      enabled: true,
      maxContextWindow: 32000,
      supportsTools: true,
      supportsVision: false,
      supportsStreaming: true,
      supportsReasoning: false,
      statefulContext: true,
      costTier: 'medium',
      priority: 10,
      apiKeyEnv: 'BACKEND_A_KEY',
    }]),
  };
  const registry = createBackendRegistryFromEnv(env);
  const backend = registry.get('dify-a');
  assert.equal(backend.credentialEnv, 'BACKEND_A_KEY');
  assert.equal(JSON.stringify(backend).includes('secret-backend-key'), false);
  assert.deepEqual(backendCredentialResolverFromEnv(env)(backend), { apiKey: 'secret-backend-key' });
});

test('routing and migration telemetry is metadata-only and exposes deterministic fields', () => {
  const canonical = new CanonicalRequest({
    traceId: 'trace-1',
    clientType: 'dsh',
    sessionIdHash: 'session-hash-only',
    providerId: 'gateway',
    backendId: 'adaptive-router',
    model: 'adaptive',
    estimatedPromptTokens: 90000,
    contextWindow: 128000,
    contextUtilization: 0.703125,
    messageCount: 4,
    toolCount: 1,
    toolSchemaEstimatedTokens: 100,
    policyVersion: 'gateway-context-compression-v1',
  });
  const decision = {
    backendId: 'adaptive-router',
    model: 'adaptive',
    compression: 'none',
    policyVersion: 'gateway-context-compression-v1',
  };
  const record = createTelemetryRecord(canonical, decision, {
    success: true,
    latencyMs: 20,
    routing: {
      selectedBackend: 'dify-b',
      previousBackend: 'dify-a',
      migrationRequired: true,
      reasonCodes: ['CONTEXT_LIMIT'],
      fallbackChain: ['local-large'],
      fallbackUsed: false,
      policyVersion: 'deterministic-backend-router-v1',
    },
    migration: {
      started: true,
      success: true,
      sourceBackendId: 'dify-a',
      targetBackendId: 'dify-b',
    },
    backendHealth: { state: 'HEALTHY' },
  });
  assert.equal(record.routing_selected_backend, 'dify-b');
  assert.equal(record.routing_previous_backend, 'dify-a');
  assert.equal(record.routing_migration_required, true);
  assert.deepEqual(record.routing_reason_codes, ['CONTEXT_LIMIT']);
  assert.deepEqual(record.routing_fallback_chain, ['local-large']);
  assert.equal(record.routing_fallback_used, false);
  assert.equal(record.backend_health, 'HEALTHY');
  assert.equal(record.migration_started, true);
  assert.equal(record.migration_success, true);
  assert.equal(record.source_backend, 'dify-a');
  assert.equal(record.target_backend, 'dify-b');
  assert.equal(record.policyVersion, 'deterministic-backend-router-v1');
  const serialized = JSON.stringify(record);
  assert.equal(serialized.includes('full-session-id'), false);
  assert.equal(serialized.includes('conv-A1'), false);
  assert.equal(serialized.includes('secret-backend-key'), false);
  assert.equal(serialized.includes('raw prompt'), false);
  assert.equal(serialized.includes('tool result body'), false);
});
