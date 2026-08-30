export const BackendConversationGenerationState = Object.freeze({
  BOOTSTRAPPING: 'BOOTSTRAPPING',
  ACTIVE: 'ACTIVE',
  CHECKPOINTED: 'CHECKPOINTED',
  INVALID: 'INVALID',
  ARCHIVED: 'ARCHIVED',
});

function now() { return Date.now(); }

export class BackendConversationGenerationStore {
  constructor() { this.scopes = new Map(); }

  scopeKey(sessionId, backendId, providerId, appId) {
    return `${sessionId}::${backendId}::${providerId}::${appId}`;
  }

  _list(sessionId, backendId, providerId, appId) {
    const key = this.scopeKey(sessionId, backendId, providerId, appId);
    if (!this.scopes.has(key)) this.scopes.set(key, []);
    return this.scopes.get(key);
  }

  listGenerations(sessionId, backendId, providerId, appId) {
    return this._list(sessionId, backendId, providerId, appId).map((x) => ({ ...x }));
  }

  getGeneration(sessionId, backendId, providerId, appId, generation) {
    return this._list(sessionId, backendId, providerId, appId).find((x) => x.generation === Number(generation)) || null;
  }

  getActiveGeneration(sessionId, backendId, providerId, appId) {
    const active = this._list(sessionId, backendId, providerId, appId).filter((x) => x.state === BackendConversationGenerationState.ACTIVE);
    return active.sort((a, b) => b.generation - a.generation)[0] || null;
  }

  createNextGeneration({ sessionId, backendId, providerId, appId, checkpointId, contextVersion }) {
    const list = this._list(sessionId, backendId, providerId, appId);
    const generation = list.reduce((max, item) => Math.max(max, item.generation), 0) + 1;
    const ts = now();
    const record = {
      sessionId: String(sessionId),
      backendId: String(backendId),
      providerId: String(providerId),
      appId: String(appId),
      generation,
      conversationId: '',
      state: BackendConversationGenerationState.BOOTSTRAPPING,
      checkpointId: checkpointId || null,
      contextVersion: Number(contextVersion || generation),
      createdAt: ts,
      updatedAt: ts,
    };
    list.push(record);
    return record;
  }

  ensureActive({ sessionId, backendId, providerId, appId, conversationId, checkpointId = null, contextVersion, extra = {} }) {
    let active = this.getActiveGeneration(sessionId, backendId, providerId, appId);
    if (!active) {
      active = this.createNextGeneration({ sessionId, backendId, providerId, appId, checkpointId, contextVersion });
      return this.activateGeneration({ sessionId, backendId, providerId, appId, generation: active.generation, conversationId, extra });
    }
    if (conversationId && active.conversationId && active.conversationId !== conversationId) {
      throw new Error('ACTIVE_GENERATION_CONVERSATION_ID_IMMUTABLE');
    }
    if (conversationId) active.conversationId = conversationId;
    Object.assign(active, extra, { updatedAt: now() });
    return active;
  }

  activateGeneration({ sessionId, backendId, providerId, appId, generation, conversationId, extra = {} }) {
    if (!conversationId) throw new Error('ROTATION_MISSING_CONVERSATION_ID');
    const list = this._list(sessionId, backendId, providerId, appId);
    const target = list.find((x) => x.generation === Number(generation));
    if (!target) throw new Error('GENERATION_NOT_FOUND');
    if (target.state !== BackendConversationGenerationState.BOOTSTRAPPING && target.state !== BackendConversationGenerationState.ACTIVE) {
      throw new Error(`GENERATION_NOT_ACTIVATABLE:${target.state}`);
    }
    const source = this.getActiveGeneration(sessionId, backendId, providerId, appId);
    const ts = now();
    target.conversationId = String(conversationId);
    target.state = BackendConversationGenerationState.ACTIVE;
    Object.assign(target, extra, { updatedAt: ts });
    if (source && source !== target) {
      source.state = BackendConversationGenerationState.CHECKPOINTED;
      source.updatedAt = ts;
    }
    return target;
  }

  invalidateGeneration(sessionId, backendId, providerId, appId, generation, reason) {
    const target = this.getGeneration(sessionId, backendId, providerId, appId, generation);
    if (!target) return null;
    target.state = BackendConversationGenerationState.INVALID;
    target.updatedAt = now();
    if (reason) target.failureReason = String(reason).slice(0, 160);
    return target;
  }

  updateGeneration(sessionId, backendId, providerId, appId, generation, fields = {}) {
    const target = this.getGeneration(sessionId, backendId, providerId, appId, generation);
    if (!target) return null;
    const forbidden = new Set(['sessionId', 'backendId', 'providerId', 'appId', 'generation', 'state', 'conversationId']);
    for (const [key, value] of Object.entries(fields)) if (!forbidden.has(key)) target[key] = value;
    target.updatedAt = now();
    return target;
  }

  archiveActive(sessionId, backendId, providerId, appId) {
    const active = this.getActiveGeneration(sessionId, backendId, providerId, appId);
    if (!active) return null;
    active.state = BackendConversationGenerationState.ARCHIVED;
    active.updatedAt = now();
    return active;
  }
}

export class RotationRecommendationStore {
  constructor() { this.entries = new Map(); }
  key(sessionId, backendId, providerId, appId) { return `${sessionId}::${backendId}::${providerId}::${appId}`; }
  get(sessionId, backendId, providerId, appId) { return this.entries.get(this.key(sessionId, backendId, providerId, appId)) || null; }
  set(sessionId, backendId, providerId, appId, value) {
    const entry = { recommended: true, reasonCodes: [...new Set(value?.reasonCodes || [])], updatedAt: now() };
    this.entries.set(this.key(sessionId, backendId, providerId, appId), entry);
    return entry;
  }
  clear(sessionId, backendId, providerId, appId) { this.entries.delete(this.key(sessionId, backendId, providerId, appId)); }
}

export function backendContextReductionPct(beforeTokens, afterTokens) {
  const before = Number(beforeTokens);
  const after = Number(afterTokens);
  if (!Number.isFinite(before) || before <= 0 || !Number.isFinite(after) || after < 0) return undefined;
  return ((before - after) / before) * 100;
}
