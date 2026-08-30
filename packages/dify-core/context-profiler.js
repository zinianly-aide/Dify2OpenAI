export class ContextProfiler {
  profile(canonicalRequest) {
    const utilization = canonicalRequest.contextUtilization;
    let utilizationBand = 'unknown';
    if (utilization !== undefined) {
      if (utilization >= 0.9) utilizationBand = 'critical';
      else if (utilization >= 0.75) utilizationBand = 'high';
      else if (utilization >= 0.5) utilizationBand = 'medium';
      else utilizationBand = 'low';
    }
    return Object.freeze({
      estimatedPromptTokens: canonicalRequest.estimatedPromptTokens,
      toolSchemaEstimatedTokens: canonicalRequest.toolSchemaEstimatedTokens,
      contextWindow: canonicalRequest.contextWindow,
      contextUtilization: utilization,
      utilizationBand,
      messageCount: canonicalRequest.messageCount,
      toolCount: canonicalRequest.toolCount,
    });
  }
}
