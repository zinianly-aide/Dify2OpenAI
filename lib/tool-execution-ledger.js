import { sha256 } from './canonical.js';

export class ToolExecutionLedger {
  constructor() { this.entries = new Map(); }
  argumentsHash(args) { return sha256(typeof args === 'string' ? args : JSON.stringify(args ?? {})); }
  key({ providerId, conversationId, toolCallId, argumentsHash }) { return `${providerId}::${conversationId}::${toolCallId}::${argumentsHash}`; }
  begin(input) {
    const argumentsHash = input.argumentsHash || this.argumentsHash(input.arguments);
    const key = this.key({ ...input, argumentsHash });
    const existing = this.entries.get(key);
    if (existing) return { ...existing, key, replay: existing.status === 'completed' };
    const entry = { status: 'pending', argumentsHash, toolCallId: input.toolCallId, result: null };
    this.entries.set(key, entry);
    return { ...entry, key, replay: false };
  }
  complete(input, result) { const begun = this.begin(input); const entry = { ...begun, status: 'completed', result, replay: false }; delete entry.key; this.entries.set(begun.key, entry); return { ...entry, key: begun.key }; }
  fail(input, error) { const begun = this.begin(input); const entry = { ...begun, status: 'failed', error: String(error), replay: false }; delete entry.key; this.entries.set(begun.key, entry); return { ...entry, key: begun.key }; }
  get(input) { const argumentsHash = input.argumentsHash || this.argumentsHash(input.arguments); return this.entries.get(this.key({ ...input, argumentsHash })) || null; }
}
