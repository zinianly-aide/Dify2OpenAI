export class ContextProfiler {
  profile(canonicalRequest) {
    const utilization = canonicalRequest.contextUtilization;
    return Object.freeze({
      estimatedPromptTokens: canonicalRequest.estimatedPromptTokens,
      toolSchemaEstimatedTokens: canonicalRequest.toolSchemaEstimatedTokens,
      toolSchemaTokens: canonicalRequest.toolSchemaEstimatedTokens,
      contextWindow: canonicalRequest.contextWindow,
      contextUtilization: utilization,
      utilizationBand: utilization === undefined ? 'unknown' : 'measured',
      messageCount: canonicalRequest.messageCount,
      toolCount: canonicalRequest.toolCount,
      clientType: canonicalRequest.clientType,
      backendId: canonicalRequest.backendId,
      model: canonicalRequest.model,
    });
  }
}
