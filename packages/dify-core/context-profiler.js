export class ContextProfiler {
  profile(canonicalRequest) {
    const utilization = canonicalRequest.contextUtilization;
    let utilizationBand = 'unknown';
    if (utilization !== undefined) {
      if (utilization >= 0.92) utilizationBand = 'critical';
      else if (utilization >= 0.82) utilizationBand = 'high';
      else if (utilization >= 0.70) utilizationBand = 'elevated';
      else if (utilization >= 0.55) utilizationBand = 'medium';
      else utilizationBand = 'low';
    }
    return Object.freeze({
      estimatedPromptTokens: canonicalRequest.estimatedPromptTokens,
      toolSchemaEstimatedTokens: canonicalRequest.toolSchemaEstimatedTokens,
      toolSchemaTokens: canonicalRequest.toolSchemaEstimatedTokens,
      contextWindow: canonicalRequest.contextWindow,
      contextUtilization: utilization,
      utilizationBand,
      messageCount: canonicalRequest.messageCount,
      toolCount: canonicalRequest.toolCount,
      clientType: canonicalRequest.clientType,
      backendId: canonicalRequest.backendId,
      model: canonicalRequest.model,
    });
  }
}
