export function createGatewayDecisionEvent(canonicalRequest, decision, result) {
  const compression = result?.compressionResult;
  const reconciliation = result?.backendReconciliation;
  const checkpoint = result?.checkpointRecommendation;
  return Object.freeze({
    traceId: canonicalRequest.traceId,
    ...(canonicalRequest.sessionIdHash === undefined ? {} : { sessionIdHash: canonicalRequest.sessionIdHash }),
    clientType: canonicalRequest.clientType,
    input: {
      estimatedPromptTokens: canonicalRequest.estimatedPromptTokens,
      ...(canonicalRequest.contextWindow === undefined ? {} : { contextWindow: canonicalRequest.contextWindow }),
      ...(canonicalRequest.contextUtilization === undefined ? {} : { contextUtilization: canonicalRequest.contextUtilization }),
      messageCount: canonicalRequest.messageCount,
      toolCount: canonicalRequest.toolCount,
      toolSchemaTokens: canonicalRequest.toolSchemaEstimatedTokens,
    },
    decision: {
      backendId: decision.backendId,
      ...(decision.model === undefined ? {} : { model: decision.model }),
      compression: decision.compression,
      ...(decision.compressionForced ? { compressionForced: true } : {}),
      reasonCodes: [...decision.reasonCodes],
    },
    ...(compression ? {
      compression: {
        mode: compression.mode,
        beforeTokens: compression.beforeTokens,
        afterTokens: compression.afterTokens,
        savedTokens: compression.savedTokens,
        ...(compression.beforeUtilization === undefined ? {} : { beforeUtilization: compression.beforeUtilization }),
        ...(compression.afterUtilization === undefined ? {} : { afterUtilization: compression.afterUtilization }),
        ...(compression.targetUtilization === undefined ? {} : { targetUtilization: compression.targetUtilization }),
        compressionPasses: compression.compressionPasses ?? 0,
        targetReached: compression.targetReached ?? false,
        unableToReachTarget: compression.unableToReachTarget ?? false,
        preservedRecentTurns: compression.preservedRecentTurns,
        reasonCodes: [...compression.reasonCodes],
      },
    } : {}),
    ...(reconciliation ? { backendContext: { ...reconciliation } } : {}),
    ...(checkpoint ? { checkpointRecommendation: { recommended: checkpoint.recommended, reasonCodes: [...checkpoint.reasonCodes] } } : {}),
    ...(result === undefined ? {} : {
      result: {
        success: result.success,
        ...(result.latencyMs === undefined ? {} : { latencyMs: result.latencyMs }),
        ...(result.firstTokenLatencyMs === undefined ? {} : { firstTokenLatencyMs: result.firstTokenLatencyMs }),
        ...(result.promptTokens === undefined ? {} : { promptTokens: result.promptTokens }),
        ...(result.completionTokens === undefined ? {} : { completionTokens: result.completionTokens }),
        ...(result.retryCount === undefined ? {} : { retryCount: result.retryCount }),
      },
    }),
    policyVersion: decision.policyVersion || canonicalRequest.policyVersion,
  });
}
