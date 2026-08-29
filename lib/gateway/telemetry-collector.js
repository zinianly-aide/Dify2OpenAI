import { createGatewayDecisionEvent } from './decision-event.js';

function createTelemetryRecord(canonicalRequest, decision, result) {
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

export { createTelemetryRecord };
