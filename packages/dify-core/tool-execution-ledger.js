import { canonicalJson, sha256 } from './canonical.js';

export const ToolExecutionStatus = Object.freeze({
  SEEN: 'seen',
  RUNNING: 'running',
  SUCCEEDED: 'completed',
  FAILED: 'failed',
  RESULT_FORWARDED: 'result_forwarded',
});

export class ToolExecutionLedger {
  constructor() { this.entries = new Map(); }
  argumentsHash(args) {
    if (typeof args === 'string') {
      try { return sha256(canonicalJson(JSON.parse(args))); } catch { return sha256(args); }
    }
    return sha256(canonicalJson(args ?? {}));
  }
  key({ providerId, sessionId, conversationId, toolCallId, argumentsHash, appId = '' }) {
    const stableSessionId = sessionId ?? conversationId;
    return `${providerId}::${appId}::${stableSessionId}::${toolCallId}::${argumentsHash}`;
  }
  begin(input) {
    const argumentsHash = input.argumentsHash || this.argumentsHash(input.arguments);
    const key = this.key({ ...input, argumentsHash });
    const existing = this.entries.get(key);
    if (existing) return { ...existing, key, duplicate: true, replay: existing.status === ToolExecutionStatus.SUCCEEDED || existing.status === ToolExecutionStatus.RESULT_FORWARDED };
    const entry = { status: 'pending', argumentsHash, toolCallId: input.toolCallId, result: null };
    this.entries.set(key, entry);
    return { ...entry, key, duplicate: false, replay: false };
  }
  complete(input, result) {
    const begun = this.begin(input);
    const entry = { ...begun, status: ToolExecutionStatus.SUCCEEDED, result, duplicate: false, replay: false };
    delete entry.key;
    this.entries.set(begun.key, entry);
    return { ...entry, key: begun.key };
  }
  markForwarded(input) {
    const argumentsHash = input.argumentsHash || this.argumentsHash(input.arguments);
    const key = this.key({ ...input, argumentsHash });
    const existing = this.entries.get(key);
    if (!existing) return null;
    const entry = { ...existing, status: ToolExecutionStatus.RESULT_FORWARDED };
    this.entries.set(key, entry);
    return { ...entry, key };
  }
  fail(input, error) {
    const begun = this.begin(input);
    const entry = { ...begun, status: ToolExecutionStatus.FAILED, error: String(error), duplicate: false, replay: false };
    delete entry.key;
    this.entries.set(begun.key, entry);
    return { ...entry, key: begun.key };
  }
  get(input) {
    const argumentsHash = input.argumentsHash || this.argumentsHash(input.arguments);
    return this.entries.get(this.key({ ...input, argumentsHash })) || null;
  }
}
