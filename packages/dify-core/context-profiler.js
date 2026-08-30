function utilization(tokens, contextWindow) {
  const window = Number(contextWindow);
  return Number.isFinite(window) && window > 0 ? Math.min(1, Number(tokens) / window) : undefined;
}

export class ContextProfiler {
  profile(canonicalRequest) {
    const contextUtilization = canonicalRequest.contextUtilization;
    return Object.freeze({
      estimatedPromptTokens: canonicalRequest.estimatedPromptTokens,
      toolSchemaEstimatedTokens: canonicalRequest.toolSchemaEstimatedTokens,
      toolSchemaTokens: canonicalRequest.toolSchemaEstimatedTokens,
      contextWindow: canonicalRequest.contextWindow,
      contextUtilization,
      utilizationBand: contextUtilization === undefined ? 'unknown' : 'measured',
      messageCount: canonicalRequest.messageCount,
      toolCount: canonicalRequest.toolCount,
      clientType: canonicalRequest.clientType,
      backendId: canonicalRequest.backendId,
      model: canonicalRequest.model,
    });
  }

  reprofile(previousProfile, fields = {}) {
    const estimatedPromptTokens = Number(fields.estimatedPromptTokens ?? previousProfile?.estimatedPromptTokens ?? 0);
    const contextWindow = fields.contextWindow ?? previousProfile?.contextWindow;
    const contextUtilization = utilization(estimatedPromptTokens, contextWindow);
    return Object.freeze({
      ...previousProfile,
      ...fields,
      estimatedPromptTokens,
      contextWindow,
      contextUtilization,
      utilizationBand: contextUtilization === undefined ? 'unknown' : 'measured',
    });
  }
}
