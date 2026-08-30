import { createGatewayDecisionEvent } from './decision-event.js';
import { DecisionEventStore } from './decision-event-store.js';

export function createTelemetryRecord(canonicalRequest, decision, result) {
  const compression = result?.compressionResult;
  const reconciliation = result?.backendReconciliation;
  const checkpoint = result?.checkpointRecommendation;
  const rotation = result?.rotation || {};
  const routing = result?.routing || {};
  const migration = result?.migration || {};
  const toolOptimization = result?.toolOptimization || {};
  const backendHealth = result?.backendHealth || routing.backendHealth;
  const policySelection = result?.policySelection || {};
  const guardrail = result?.guardrail || {};
  const promotion = result?.promotion || {};
  const rollback = result?.rollback || {};
  const policyVersion = policySelection.selectedPolicyVersion || routing.policyVersion || decision.policyVersion || canonicalRequest.policyVersion;
  const guardrailReasonCodes = Array.isArray(guardrail.reasonCodes) ? [...guardrail.reasonCodes] : [];
  const rollbackReason = Array.isArray(rollback.rollbackReason) ? [...rollback.rollbackReason] : (rollback.rollbackReason ? [String(rollback.rollbackReason)] : []);
  return Object.freeze({
    timestamp: result?.timestamp || new Date().toISOString(),
    traceId: canonicalRequest.traceId,
    clientType: canonicalRequest.clientType,
    taskType: canonicalRequest.taskType ?? null,
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
    requiresTools: canonicalRequest.requiresTools === true || canonicalRequest.toolCount > 0,
    hasImages: canonicalRequest.hasImages === true,
    reasoningRequired: canonicalRequest.reasoningRequired === true,
    streamingRequired: canonicalRequest.streamingRequired === true,
    portableContextAvailable: result?.portableContextAvailable ?? null,
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
    routingSelectedBackend: routing.selectedBackend ?? routing.backendId ?? null,
    routingPreviousBackend: routing.previousBackend ?? null,
    routingMigrationRequired: routing.migrationRequired === true,
    routingReasonCodes: Array.isArray(routing.reasonCodes) ? [...routing.reasonCodes] : [],
    routingFallbackChain: Array.isArray(routing.fallbackChain) ? [...routing.fallbackChain] : [],
    routingFallbackUsed: routing.fallbackUsed === true,
    backendHealth: backendHealth?.state ?? backendHealth ?? null,
    migrationStarted: migration.started === true,
    migrationSuccess: migration.success === true,
    migrationFailureReason: migration.failureReason ?? null,
    sourceBackend: migration.sourceBackendId ?? routing.previousBackend ?? null,
    targetBackend: migration.targetBackendId ?? routing.selectedBackend ?? routing.backendId ?? null,
    toolCountBefore: toolOptimization.beforeToolCount ?? canonicalRequest.toolCount ?? 0,
    toolCountAfter: toolOptimization.afterToolCount ?? canonicalRequest.toolCount ?? 0,
    toolSchemaTokensBefore: toolOptimization.beforeSchemaTokens ?? canonicalRequest.toolSchemaEstimatedTokens ?? 0,
    toolSchemaTokensAfter: toolOptimization.afterSchemaTokens ?? canonicalRequest.toolSchemaEstimatedTokens ?? 0,
    toolSchemaTokensSaved: toolOptimization.savedTokens ?? 0,
    toolPruningMode: toolOptimization.mode ?? 'SEND_ALL',
    toolPruningConfidence: toolOptimization.confidence ?? null,
    toolPruningConfidenceScore: toolOptimization.confidenceScore ?? null,
    toolPruningReasonCodes: Array.isArray(toolOptimization.reasonCodes) ? [...toolOptimization.reasonCodes] : [],
    toolRecoveryTriggered: toolOptimization.recoveryTriggered === true,
    toolRecoveryReason: toolOptimization.recoveryReason ?? null,
    toolRecoverySuccess: toolOptimization.recoverySuccess === true,
    toolSuccessRate: result?.toolSuccessRate ?? null,
    estimatedCost: result?.estimatedCost ?? null,
    policyVersion,
    policyAssignment: policySelection.policyAssignment ?? 'ACTIVE_BASELINE',
    canaryStage: policySelection.canaryStage ?? null,
    canaryBucket: policySelection.canaryBucket ?? null,
    promotionEligible: promotion.promotionEligible ?? guardrail.promotionEligible ?? null,
    promotionBlockedReason: promotion.promotionBlockedReason ?? policySelection.selectionFallbackReason ?? null,
    guardrailStatus: guardrail.status ?? null,
    guardrailReasonCodes,
    rollbackTriggered: rollback.rollbackTriggered === true,
    rollbackReason,
    rollbackTargetPolicy: rollback.rollbackTargetPolicy ?? null,
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
    routing_selected_backend: routing.selectedBackend ?? routing.backendId ?? null,
    routing_previous_backend: routing.previousBackend ?? null,
    routing_migration_required: routing.migrationRequired === true,
    routing_reason_codes: Array.isArray(routing.reasonCodes) ? [...routing.reasonCodes] : [],
    routing_fallback_chain: Array.isArray(routing.fallbackChain) ? [...routing.fallbackChain] : [],
    routing_fallback_used: routing.fallbackUsed === true,
    backend_health: backendHealth?.state ?? backendHealth ?? null,
    migration_started: migration.started === true,
    migration_success: migration.success === true,
    migration_failure_reason: migration.failureReason ?? null,
    source_backend: migration.sourceBackendId ?? routing.previousBackend ?? null,
    target_backend: migration.targetBackendId ?? routing.selectedBackend ?? routing.backendId ?? null,
    tool_count_before: toolOptimization.beforeToolCount ?? canonicalRequest.toolCount ?? 0,
    tool_count_after: toolOptimization.afterToolCount ?? canonicalRequest.toolCount ?? 0,
    tool_schema_tokens_before: toolOptimization.beforeSchemaTokens ?? canonicalRequest.toolSchemaEstimatedTokens ?? 0,
    tool_schema_tokens_after: toolOptimization.afterSchemaTokens ?? canonicalRequest.toolSchemaEstimatedTokens ?? 0,
    tool_schema_tokens_saved: toolOptimization.savedTokens ?? 0,
    tool_pruning_mode: toolOptimization.mode ?? 'SEND_ALL',
    tool_pruning_confidence: toolOptimization.confidence ?? null,
    tool_pruning_reason_codes: Array.isArray(toolOptimization.reasonCodes) ? [...toolOptimization.reasonCodes] : [],
    tool_recovery_triggered: toolOptimization.recoveryTriggered === true,
    tool_recovery_reason: toolOptimization.recoveryReason ?? null,
    tool_recovery_success: toolOptimization.recoverySuccess === true,
    policy_version: policyVersion,
    policy_assignment: policySelection.policyAssignment ?? 'ACTIVE_BASELINE',
    canary_stage: policySelection.canaryStage ?? null,
    canary_bucket: policySelection.canaryBucket ?? null,
    promotion_eligible: promotion.promotionEligible ?? guardrail.promotionEligible ?? null,
    promotion_blocked_reason: promotion.promotionBlockedReason ?? policySelection.selectionFallbackReason ?? null,
    guardrail_status: guardrail.status ?? null,
    guardrail_reason_codes: guardrailReasonCodes,
    rollback_triggered: rollback.rollbackTriggered === true,
    rollback_reason: rollbackReason,
    rollback_target_policy: rollback.rollbackTargetPolicy ?? null,
    latencyMs: result?.latencyMs ?? 0,
    firstTokenLatencyMs: result?.firstTokenLatencyMs ?? null,
    retryCount: result?.retryCount ?? 0,
    success: result?.success ?? false,
    errorType: result?.errorType ?? null,
  });
}

export class TelemetryCollector {
  constructor(options = {}) {
    this.sink = options.sink || ((payload) => console.log(JSON.stringify({ component: 'gateway-decision', ...payload })));
    this.events = [];
    this.records = [];
    this.decisionEventStore = options.decisionEventStore || new DecisionEventStore();
  }

  collect(canonicalRequest, decision, result) {
    const event = createGatewayDecisionEvent(canonicalRequest, decision, result);
    const telemetry = createTelemetryRecord(canonicalRequest, decision, result);
    this.events.push(event);
    this.records.push(telemetry);
    const storedDecisionEvent = this.decisionEventStore.append(telemetry);
    this.sink({ event, telemetry });
    return { event, telemetry, storedDecisionEvent };
  }

  snapshot() {
    return { events: [...this.events], records: [...this.records], decisionDataset: this.decisionEventStore.snapshot() };
  }

  clear() {
    this.events.length = 0;
    this.records.length = 0;
    this.decisionEventStore.clear();
  }
}
