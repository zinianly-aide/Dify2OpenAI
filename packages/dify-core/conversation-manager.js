import {
  BackendConversationGenerationState,
  BackendConversationGenerationStore,
} from './backend-conversation-generation.js';

export const ConversationState = Object.freeze({
  BOOTSTRAP: 'BOOTSTRAP',
  CONTINUE: 'CONTINUE',
  TOOL_CONTINUE: 'TOOL_CONTINUE',
  RECOVER: 'RECOVER',
  RESET: 'RESET',
  CHECKPOINT: 'CHECKPOINT',
  ROTATE: 'ROTATE',
  ROTATE_BOOTSTRAP: 'ROTATE_BOOTSTRAP',
});

export const ContextStrategy = Object.freeze({
  FULL_BOOTSTRAP: 'FULL_BOOTSTRAP',
  DELTA_CONTINUE: 'DELTA_CONTINUE',
  TOOL_CONTINUE: 'TOOL_CONTINUE',
  RECOVERY_BOOTSTRAP: 'RECOVERY_BOOTSTRAP',
  CHECKPOINT_BOOTSTRAP: 'CHECKPOINT_BOOTSTRAP',
});

export class MemoryConversationStore {
  constructor(options = {}) {
    this.generations = options.generations || new BackendConversationGenerationStore();
  }

  _backendId(providerId, difyAppId = '') { return `${providerId}::${difyAppId}`; }

  get(dshConversationId, providerId, difyAppId = '') {
    const backendId = this._backendId(providerId, difyAppId);
    const active = this.generations.getActiveGeneration(dshConversationId, backendId, providerId, difyAppId);
    return active ? { ...active, valid: true } : null;
  }

  set(dshConversationId, providerId, difyAppId, state) {
    const backendId = state?.backendId || this._backendId(providerId, difyAppId);
    const active = this.generations.getActiveGeneration(dshConversationId, backendId, providerId, difyAppId);
    const extra = { ...state };
    delete extra.conversationId;
    delete extra.valid;
    delete extra.backendId;
    if (active) {
      if (state?.conversationId && active.conversationId && active.conversationId !== state.conversationId) {
        throw new Error('ACTIVE_GENERATION_CONVERSATION_ID_IMMUTABLE');
      }
      if (state?.conversationId && !active.conversationId) active.conversationId = String(state.conversationId);
      Object.assign(active, extra, { updatedAt: state?.updatedAt || Date.now() });
      return { ...active, valid: true };
    }
    if (!state?.conversationId) return null;
    const created = this.generations.ensureActive({
      sessionId: dshConversationId,
      backendId,
      providerId,
      appId: difyAppId,
      conversationId: state.conversationId,
      contextVersion: state.contextVersion,
      checkpointId: state.checkpointId,
      extra,
    });
    return { ...created, valid: true };
  }

  invalidate(dshConversationId, providerId, difyAppId = '') {
    const backendId = this._backendId(providerId, difyAppId);
    const active = this.generations.getActiveGeneration(dshConversationId, backendId, providerId, difyAppId);
    if (!active) return null;
    this.generations.invalidateGeneration(dshConversationId, backendId, providerId, difyAppId, active.generation, 'REMOTE_INVALID');
    return { ...active, valid: false };
  }

  resetProvider(dshConversationId, providerId, difyAppId = '') {
    return this.generations.archiveActive(dshConversationId, this._backendId(providerId, difyAppId), providerId, difyAppId);
  }

  getActiveGeneration(dshConversationId, providerId, difyAppId = '', backendId = this._backendId(providerId, difyAppId)) {
    return this.generations.getActiveGeneration(dshConversationId, backendId, providerId, difyAppId);
  }

  getGeneration(dshConversationId, providerId, difyAppId = '', generation, backendId = this._backendId(providerId, difyAppId)) {
    return this.generations.getGeneration(dshConversationId, backendId, providerId, difyAppId, generation);
  }

  listGenerations(dshConversationId, providerId, difyAppId = '', backendId = this._backendId(providerId, difyAppId)) {
    return this.generations.listGenerations(dshConversationId, backendId, providerId, difyAppId);
  }

  createNextGeneration({ dshConversationId, providerId, difyAppId = '', backendId = this._backendId(providerId, difyAppId), checkpointId, contextVersion }) {
    return this.generations.createNextGeneration({
      sessionId: dshConversationId,
      backendId,
      providerId,
      appId: difyAppId,
      checkpointId,
      contextVersion,
    });
  }

  activateGeneration({ dshConversationId, providerId, difyAppId = '', backendId = this._backendId(providerId, difyAppId), generation, conversationId, extra }) {
    return this.generations.activateGeneration({
      sessionId: dshConversationId,
      backendId,
      providerId,
      appId: difyAppId,
      generation,
      conversationId,
      extra,
    });
  }

  invalidateGeneration({ dshConversationId, providerId, difyAppId = '', backendId = this._backendId(providerId, difyAppId), generation, reason }) {
    return this.generations.invalidateGeneration(dshConversationId, backendId, providerId, difyAppId, generation, reason);
  }

  snapshot(dshConversationId) {
    const out = {};
    for (const [scope, list] of this.generations.scopes.entries()) {
      if (!scope.startsWith(`${dshConversationId}::`)) continue;
      out[scope] = list.map((item) => ({ ...item }));
    }
    return out;
  }
}

export function resolveConversationState({
  remoteState,
  messages = [],
  toolCalls = [],
  toolResults = [],
  reset = false,
  remoteInvalid = false,
  checkpoint = false,
  rotating = false,
}) {
  if (reset) return { state: ConversationState.RESET, contextStrategy: ContextStrategy.FULL_BOOTSTRAP };
  if (rotating) return { state: ConversationState.ROTATE_BOOTSTRAP, contextStrategy: ContextStrategy.CHECKPOINT_BOOTSTRAP };
  if (checkpoint) return { state: ConversationState.CHECKPOINT, contextStrategy: ContextStrategy.CHECKPOINT_BOOTSTRAP };
  if (remoteInvalid || (remoteState && remoteState.valid === false) || remoteState?.state === BackendConversationGenerationState.INVALID) {
    return { state: ConversationState.RECOVER, contextStrategy: ContextStrategy.RECOVERY_BOOTSTRAP };
  }
  const hasRemote = Boolean(remoteState?.conversationId && remoteState?.valid !== false && remoteState?.state !== BackendConversationGenerationState.INVALID);
  const hasToolResult = toolResults.length > 0 || messages.some((m) => m.role === 'tool' || m.role === 'function');
  if (!hasRemote) return { state: ConversationState.BOOTSTRAP, contextStrategy: ContextStrategy.FULL_BOOTSTRAP };
  if (hasToolResult || toolCalls.length > 0) return { state: ConversationState.TOOL_CONTINUE, contextStrategy: ContextStrategy.TOOL_CONTINUE };
  return { state: ConversationState.CONTINUE, contextStrategy: ContextStrategy.DELTA_CONTINUE };
}
