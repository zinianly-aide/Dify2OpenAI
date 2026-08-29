import { createGatewayDecisionEvent } from './decision-event.js';

export class TelemetryCollector {
  constructor(options = {}) {
    this.sink = options.sink || ((event) => console.log(JSON.stringify({ component: 'gateway-decision', ...event })));
    this.events = [];
  }

  collect(canonicalRequest, decision, result) {
    const event = createGatewayDecisionEvent(canonicalRequest, decision, result);
    this.events.push(event);
    this.sink(event);
    return event;
  }

  snapshot() {
    return [...this.events];
  }

  clear() {
    this.events.length = 0;
  }
}
