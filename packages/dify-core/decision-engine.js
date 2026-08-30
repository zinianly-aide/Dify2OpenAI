import { CompressionPolicy } from './compression-policy.js';

export class DecisionEngine {
  constructor(options = {}) {
    this.policyVersion = options.policyVersion || 'gateway-context-compression-v1';
    this.compressionPolicy = options.compressionPolicy || new CompressionPolicy(options.compressionConfig);
  }

  decide(canonicalRequest, contextProfile, routing = {}) {
    const backendId = String(routing.backendId || canonicalRequest.backendId || 'unresolved');
    const model = routing.model || canonicalRequest.model;
    const compression = this.compressionPolicy.decide(contextProfile);
    const utilizationCode = contextProfile.contextUtilization === undefined
      ? 'context_utilization=unknown'
      : `context_utilization=${Number(contextProfile.contextUtilization).toFixed(2)}`;
    const reasonCodes = [
      `client=${canonicalRequest.clientType}`,
      `backend=${backendId}`,
      'backend_health=unknown',
      'policy=context_compression_v1',
      utilizationCode,
      ...compression.reasonCodes,
      `tools_present=${canonicalRequest.toolCount}`,
    ];
    return Object.freeze({
      backendId,
      ...(model === undefined ? {} : { model }),
      compression: compression.mode,
      compressionForced: compression.forced,
      reasonCodes,
      policyVersion: this.policyVersion,
    });
  }
}
