import { createGatewayDecisionEvent } from './decision-event.js';

function createTelemetryRecord(canonicalRequest, decision, result) {
  return Object.freeze({
    traceId: canonicalRequest.traceId,
    clientType: canonicalRequest.clientType,
    ...(canonicalRequest.sessionIdHash === undefined ? {} : { sessionIdHash: canonicalRequest.sessionIdHash }),
    providerId: canonicalRequest.providerId,
    backendId: decision.backendId,
    ...(decision.model === undefined ? {} : { model: decision.model }),
    estimatedPromptTokens: canonicalRequest.estimatedPromptTokens,
    ...(result?.promptTokens === undefined ? {} : { promptTokens: result.promptTokens }),
    completionTokens: result?.completionTokens ?? 0,
    ...(canonicalRequest.contextWindow === undefined ? {} : { contextWindow: canonicalRequest.contextWindow }),
    ...(canonicalRequest.contextUtilization === undefined ? {} : { contextUtilization: canonicalRequest.contextUtilization }),
    messageCount: canonicalRequest.messageCount,
    toolCount: canonicalRequest.toolCount,
    toolSchemaEstimatedTokens: canonicalRequest.toolSchemaEstimatedTokens,
    latencyMs: result?.latencyMs ?? 0,
    ...(result?.firstTokenLatencyMs === undefined ? {} : { firstTokenLatencyMs: result.firstTokenLatencyMs }),
    retryCount: result?.retryCount ?? 0,
    success: result?.success ?? false,
    ...(result?.errorType === undefined ? {} : { errorType: result.errorType }),
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
