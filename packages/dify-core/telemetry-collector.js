import { createGatewayDecisionEvent } from './decision-event.js';

export function createTelemetryRecord(canonicalRequest, decision, result) {
  const compression = result?.compressionResult;
  const reconciliation = result?.backendReconciliation;
  const checkpoint = result?.checkpointRecommendation;
  const rotation = result?.rotation || {};
  return Object.freeze({
    traceId: canonicalRequest.traceId,
    clientType: canonicalRequest.clientType,
    sessionIdHash: canonicalRequest.sessionIdHash ?? null,
    providerId: canonicalRequest.providerId,
    backendId: decision.backendId,
    model: decision.model ?? null,
    estimatedPromptTokens: canonicalRequest.estimatedPromptTokens,
    promptTokens: result?.promptTokens ?? null,
    completionTokens: result?.completionTokens ?? 0,
    contextWindow: canonicalRequest.contextWindow ?? null,
    contextUtilization: canonicalRequest.contextUtilization ?? null,
    messageCount: canonicalRequest.messageCount,
    toolCount: canonicalRequest.toolCount,
    toolSchemaEstimatedTokens: canonicalRequest.toolSchemaEstimatedTokens,
    compressionMode: compression?.mode ?? decision.compression ?? 'none',
    compressionBeforeTokens: compression?.beforeTokens ?? canonicalRequest.estimatedPromptTokens,
    compressionAfterTokens: compression?.afterTokens ?? canonicalRequest.estimatedPromptTokens,
    compressionSavedTokens: compression?.savedTokens ?? 0,
    compressionBeforeUtilization: compression?.beforeUtilization ?? canonicalRequest.contextUtilization ?? null,
    compressionAfterUtilization: compression?.afterUtilization ?? null,
    compressionTargetUtilization: compression?.targetUtilization ?? null,
    compressionPasses: compression?.compressionPasses ?? 0,
    compressionTargetReached: compression?.targetReached ?? false,
    compressionUnableToReachTarget: compression?.unableToReachTarget ?? false,
    compressionPreservedRecentTurns: compression?.preservedRecentTurns ?? null,
    compressionReasonCodes: Array.isArray(compression?.reasonCodes) ? [...compression.reasonCodes] : [],
    gatewayEstimatedInputTokens: reconciliation?.gatewayEstimatedInputTokens ?? canonicalRequest.estimatedPromptTokens,
    gatewayCompressedTokens: reconciliation?.gatewayCompressedTokens ?? compression?.afterTokens ?? canonicalRequest.estimatedPromptTokens,
    backendPromptTokens: reconciliation?.backendPromptTokens ?? null,
    backendCompletionTokens: reconciliation?.backendCompletionTokens ?? null,
    contextAmplification: reconciliation?.contextAmplification ?? null,
    backendContextUtilization: reconciliation?.backendContextUtilization ?? null,
    checkpointRecommended: checkpoint?.recommended ?? false,
    checkpointReason: Array.isArray(checkpoint?.reasonCodes) ? [...checkpoint.reasonCodes] : [],
    checkpointCreated: rotation.checkpointCreated === true,
    sourceGeneration: rotation.sourceGeneration ?? null,
    targetGeneration: rotation.targetGeneration ?? null,
    rotationStarted: rotation.rotationStarted === true,
    rotationSuccess: rotation.rotationSuccess === true,
    rotationFailureReason: rotation.rotationFailureReason ?? null,
    checkpointBeforeTokens: rotation.checkpointBeforeTokens ?? null,
    checkpointAfterTokens: rotation.checkpointAfterTokens ?? null,
    oldConversationIdHash: rotation.oldConversationIdHash ?? null,
    newConversationIdHash: rotation.newConversationIdHash ?? null,
    backendContextReductionPct: rotation.backendContextReductionPct ?? null,
    compression_passes: compression?.compressionPasses ?? 0,
    compression_target_reached: compression?.targetReached ?? false,
    compression_unable_to_reach_target: compression?.unableToReachTarget ?? false,
    gateway_estimated_input_tokens: reconciliation?.gatewayEstimatedInputTokens ?? canonicalRequest.estimatedPromptTokens,
    gateway_compressed_tokens: reconciliation?.gatewayCompressedTokens ?? compression?.afterTokens ?? canonicalRequest.estimatedPromptTokens,
    backend_prompt_tokens: reconciliation?.backendPromptTokens ?? null,
    backend_completion_tokens: reconciliation?.backendCompletionTokens ?? null,
    context_amplification: reconciliation?.contextAmplification ?? null,
    checkpoint_recommended: checkpoint?.recommended ?? false,
    checkpoint_reason: Array.isArray(checkpoint?.reasonCodes) ? [...checkpoint.reasonCodes] : [],
    checkpoint_created: rotation.checkpointCreated === true,
    source_generation: rotation.sourceGeneration ?? null,
    target_generation: rotation.targetGeneration ?? null,
    rotation_started: rotation.rotationStarted === true,
    rotation_success: rotation.rotationSuccess === true,
    rotation_failure_reason: rotation.rotationFailureReason ?? null,
    checkpoint_before_tokens: rotation.checkpointBeforeTokens ?? null,
    checkpoint_after_tokens: rotation.checkpointAfterTokens ?? null,
    old_conversation_id_hash: rotation.oldConversationIdHash ?? null,
    new_conversation_id_hash: rotation.newConversationIdHash ?? null,
    backend_context_reduction_pct: rotation.backendContextReductionPct ?? null,
    latencyMs: result?.latencyMs ?? 0,
    firstTokenLatencyMs: result?.firstTokenLatencyMs ?? null,
    retryCount: result?.retryCount ?? 0,
    success: result?.success ?? false,
    errorType: result?.errorType ?? null,
    policyVersion: decision.policyVersion || canonicalRequest.policyVersion,
  });
}

export class TelemetryCollector {
  constructor(options = {}) {
    this.sink = options.sink || ((payload) => console.log(JSON.stringify({ component: 'gateway-decision', ...payload })));
    this.events = [];
    this.records = [];
  }

  collect(canonicalRequest, decision, result) {
    const event = createGatewayDecisionEvent(canonicalRequest, decision, result);
    const telemetry = createTelemetryRecord(canonicalRequest, decision, result);
    this.events.push(event);
    this.records.push(telemetry);
    this.sink({ event, telemetry });
    return { event, telemetry };
  }

  snapshot() {
    return { events: [...this.events], records: [...this.records] };
  }

  clear() {
    this.events.length = 0;
    this.records.length = 0;
  }
}
