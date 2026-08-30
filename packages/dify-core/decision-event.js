export function createGatewayDecisionEvent(canonicalRequest, decision, result) {
  const compression = result?.compressionResult;
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
        preservedRecentTurns: compression.preservedRecentTurns,
        reasonCodes: [...compression.reasonCodes],
      },
    } : {}),
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
