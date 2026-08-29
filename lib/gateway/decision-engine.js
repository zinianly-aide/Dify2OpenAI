export class DecisionEngine {
  constructor(options = {}) {
    this.policyVersion = options.policyVersion || 'gateway-static-v1';
  }

  decide(canonicalRequest, contextProfile, routing = {}) {
    const backendId = String(routing.backendId || canonicalRequest.backendId || 'unresolved');
    const model = routing.model || canonicalRequest.model;
    const reasonCodes = [
      `client=${canonicalRequest.clientType}`,
      `backend=${backendId}`,
      'backend_health=unknown',
      'policy=static',
      'compression=none',
    ];
    if (contextProfile.contextUtilization === undefined) {
      reasonCodes.push('context_utilization=unknown');
      reasonCodes.push('compression_threshold_not_evaluated');
    } else {
      reasonCodes.push(`context_utilization=${contextProfile.contextUtilization.toFixed(2)}`);
      reasonCodes.push(contextProfile.contextUtilization >= 0.75
        ? 'compression_candidate_observed_only'
        : 'compression_threshold_not_reached');
    }
    if (canonicalRequest.toolCount > 0) reasonCodes.push(`tools_present=${canonicalRequest.toolCount}`);
    else reasonCodes.push('tools_present=0');

    return Object.freeze({
      backendId,
      ...(model === undefined ? {} : { model }),
      compression: 'none',
      reasonCodes,
      policyVersion: this.policyVersion,
    });
  }
}
