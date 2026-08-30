import { BackendContextMode } from './backend-registry.js';

export const MigrationReasonCode = Object.freeze({
  REQUIRED: 'MIGRATION_REQUIRED',
  CHECKPOINT_AVAILABLE: 'MIGRATION_CHECKPOINT_AVAILABLE',
  CANONICAL_CONTEXT_AVAILABLE: 'MIGRATION_CANONICAL_CONTEXT_AVAILABLE',
  BLOCKED_NO_PORTABLE_CONTEXT: 'MIGRATION_BLOCKED_NO_PORTABLE_CONTEXT',
  TARGET_STATEFUL_BOOTSTRAP: 'MIGRATION_TARGET_STATEFUL_BOOTSTRAP',
  TARGET_STATELESS_CANONICAL: 'MIGRATION_TARGET_STATELESS_CANONICAL',
});

export class ContextMigrationPlanner {
  constructor({ checkpointStore } = {}) {
    this.checkpointStore = checkpointStore;
  }

  plan({
    sessionId,
    sourceBackendId,
    targetBackendId,
    providerId,
    appId,
    targetCapabilities,
    checkpoint,
    canonicalContextAvailable = false,
  } = {}) {
    if (!targetBackendId) throw new Error('MIGRATION_TARGET_BACKEND_REQUIRED');
    if (!sourceBackendId || sourceBackendId === targetBackendId) {
      return Object.freeze({
        required: false,
        sourceBackendId: sourceBackendId || undefined,
        targetBackendId: String(targetBackendId),
        bootstrapRequired: false,
        reasonCodes: Object.freeze([]),
      });
    }

    const reliableCheckpoint = checkpoint || this.checkpointStore?.latest?.(sessionId, sourceBackendId, providerId, appId) || null;
    const contextMode = targetCapabilities?.contextMode || BackendContextMode.STATELESS;
    const portable = Boolean(reliableCheckpoint || canonicalContextAvailable);
    if (!portable) {
      return Object.freeze({
        required: true,
        sourceBackendId: String(sourceBackendId),
        targetBackendId: String(targetBackendId),
        checkpointId: undefined,
        bootstrapRequired: false,
        blocked: true,
        reasonCodes: Object.freeze([MigrationReasonCode.REQUIRED, MigrationReasonCode.BLOCKED_NO_PORTABLE_CONTEXT]),
      });
    }

    const reasons = [MigrationReasonCode.REQUIRED];
    if (reliableCheckpoint) reasons.push(MigrationReasonCode.CHECKPOINT_AVAILABLE);
    else reasons.push(MigrationReasonCode.CANONICAL_CONTEXT_AVAILABLE);
    reasons.push(contextMode === BackendContextMode.STATEFUL
      ? MigrationReasonCode.TARGET_STATEFUL_BOOTSTRAP
      : MigrationReasonCode.TARGET_STATELESS_CANONICAL);

    return Object.freeze({
      required: true,
      sourceBackendId: String(sourceBackendId),
      targetBackendId: String(targetBackendId),
      checkpointId: reliableCheckpoint?.checkpointId,
      bootstrapRequired: contextMode === BackendContextMode.STATEFUL,
      blocked: false,
      reasonCodes: Object.freeze(reasons),
    });
  }

  bootstrapMessages({ checkpoint, canonicalMessages = [], builder } = {}) {
    if (checkpoint) {
      if (!builder?.bootstrapMessages) throw new Error('CANONICAL_CONTEXT_BUILDER_REQUIRED');
      return builder.bootstrapMessages(checkpoint);
    }
    if (!Array.isArray(canonicalMessages) || canonicalMessages.length === 0) throw new Error(MigrationReasonCode.BLOCKED_NO_PORTABLE_CONTEXT);
    return canonicalMessages;
  }
}

export function assertNoCrossBackendConversationReuse({ sourceBackendId, targetBackendId, conversationId }) {
  if (sourceBackendId && targetBackendId && sourceBackendId !== targetBackendId && conversationId) {
    const error = new Error('CROSS_BACKEND_CONVERSATION_ID_FORBIDDEN');
    error.code = 'CROSS_BACKEND_CONVERSATION_ID_FORBIDDEN';
    throw error;
  }
  return true;
}
