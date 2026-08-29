export const ConversationState = Object.freeze({ BOOTSTRAP: 'BOOTSTRAP', CONTINUE: 'CONTINUE', TOOL_CONTINUE: 'TOOL_CONTINUE', RECOVER: 'RECOVER', RESET: 'RESET' });
export const ContextStrategy = Object.freeze({ FULL_BOOTSTRAP: 'FULL_BOOTSTRAP', DELTA_CONTINUE: 'DELTA_CONTINUE', TOOL_CONTINUE: 'TOOL_CONTINUE', RECOVERY_BOOTSTRAP: 'RECOVERY_BOOTSTRAP' });

export class MemoryConversationStore {
  constructor() { this.conversations = new Map(); }
  _providerKey(providerId, difyAppId = '') { return `${providerId}::${difyAppId}`; }
  _root(dshConversationId) {
    if (!this.conversations.has(dshConversationId)) this.conversations.set(dshConversationId, { providers: new Map() });
    return this.conversations.get(dshConversationId);
  }
  get(dshConversationId, providerId, difyAppId = '') { return this._root(dshConversationId).providers.get(this._providerKey(providerId, difyAppId)) || null; }
  set(dshConversationId, providerId, difyAppId, state) {
    const root = this._root(dshConversationId);
    const key = this._providerKey(providerId, difyAppId);
    root.providers.set(key, { ...(root.providers.get(key) || {}), ...state });
    return root.providers.get(key);
  }
  invalidate(dshConversationId, providerId, difyAppId = '') {
    const state = this.get(dshConversationId, providerId, difyAppId);
    if (state) state.valid = false;
    return state;
  }
  resetProvider(dshConversationId, providerId, difyAppId = '') { this._root(dshConversationId).providers.delete(this._providerKey(providerId, difyAppId)); }
  snapshot(dshConversationId) { return Object.fromEntries(this._root(dshConversationId).providers.entries()); }
}

export function resolveConversationState({ remoteState, messages = [], toolCalls = [], toolResults = [], reset = false, remoteInvalid = false }) {
  if (reset) return { state: ConversationState.RESET, contextStrategy: ContextStrategy.FULL_BOOTSTRAP };
  if (remoteInvalid || (remoteState && remoteState.valid === false)) return { state: ConversationState.RECOVER, contextStrategy: ContextStrategy.RECOVERY_BOOTSTRAP };
  const hasRemote = Boolean(remoteState?.conversationId && remoteState?.valid !== false);
  const hasToolResult = toolResults.length > 0 || messages.some((m) => m.role === 'tool' || m.role === 'function');
  if (!hasRemote) return { state: ConversationState.BOOTSTRAP, contextStrategy: ContextStrategy.FULL_BOOTSTRAP };
  if (hasToolResult || toolCalls.length > 0) return { state: ConversationState.TOOL_CONTINUE, contextStrategy: ContextStrategy.TOOL_CONTINUE };
  return { state: ConversationState.CONTINUE, contextStrategy: ContextStrategy.DELTA_CONTINUE };
}
