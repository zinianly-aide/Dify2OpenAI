import { BackendContextMode } from './backend-registry.js';
import { BackendHealthState } from './backend-health.js';
import { isFallbackEligible } from './backend-router.js';
import { assertNoCrossBackendConversationReuse } from './context-migration.js';

export class BackendAffinityStore {
  constructor() { this.map = new Map(); }
  key(sessionId, providerId = '', appId = '') { return `${sessionId}::${providerId}::${appId}`; }
  get(sessionId, providerId = '', appId = '') { return this.map.get(this.key(sessionId, providerId, appId)) || null; }
  set(sessionId, providerId = '', appId = '', backendId) {
    this.map.set(this.key(sessionId, providerId, appId), String(backendId));
    return backendId;
  }
  clear(sessionId, providerId = '', appId = '') { this.map.delete(this.key(sessionId, providerId, appId)); }
}

function toolReplayMessages(ledger, requests = []) {
  const out = [];
  for (const input of requests) {
    const entry = ledger?.get?.(input);
    if (entry?.status === 'completed' || entry?.status === 'result_forwarded') {
      out.push({ role: 'tool', tool_call_id: input.toolCallId, content: String(entry.result ?? '') });
    }
  }
  return out;
}

export class AdaptiveBackendGateway {
  constructor({ registry, router, migrationPlanner, conversationStore, checkpointManager, healthStore, toolLedger, executor, affinityStore, credentialsResolver } = {}) {
    if (!registry || !router || !migrationPlanner || !conversationStore || !executor) throw new Error('ADAPTIVE_BACKEND_GATEWAY_DEPENDENCIES_REQUIRED');
    this.registry = registry;
    this.router = router;
    this.migrationPlanner = migrationPlanner;
    this.conversationStore = conversationStore;
    this.checkpointManager = checkpointManager;
    this.healthStore = healthStore;
    this.toolLedger = toolLedger;
    this.executor = executor;
    this.affinityStore = affinityStore || new BackendAffinityStore();
    this.credentialsResolver = credentialsResolver || (() => ({}));
  }

  async execute(input = {}) {
    const sessionId = String(input.sessionId || '');
    if (!sessionId) throw new Error('GATEWAY_SESSION_REQUIRED');
    const providerId = String(input.providerId || 'gateway');
    const appId = String(input.appId || 'default');
    const currentBackendId = input.currentBackendId || this.affinityStore.get(sessionId, providerId, appId) || null;
    const routing = this.router.decide({ ...input, currentBackendId });
    if (!routing.backendId) {
      const error = new Error('NO_COMPATIBLE_BACKEND');
      error.code = 'NO_COMPATIBLE_BACKEND';
      error.routing = routing;
      throw error;
    }

    const attempted = [];
    const candidates = [routing.backendId, ...routing.fallbackChain];
    let lastError;
    for (let index = 0; index < candidates.length; index += 1) {
      const backendId = candidates[index];
      const backend = this.registry.get(backendId);
      if (!backend || !backend.enabled) continue;
      const fallbackUsed = index > 0;
      const sourceBackendId = currentBackendId;
      const migrationRequired = Boolean(sourceBackendId && sourceBackendId !== backendId);
      let checkpoint = null;
      let migration = { required: false, targetBackendId: backendId, bootstrapRequired: false, reasonCodes: [] };

      if (migrationRequired) {
        checkpoint = this.checkpointManager?.store?.latest?.(sessionId, sourceBackendId, providerId, appId) || null;
        if (!checkpoint && this.checkpointManager && Array.isArray(input.messages) && input.messages.length) {
          const sourceRemote = this.conversationStore.get(sessionId, providerId, appId, sourceBackendId);
          if (sourceRemote) {
            const created = this.checkpointManager.create({
              sessionId,
              backendId: sourceBackendId,
              providerId,
              appId,
              sourceGeneration: sourceRemote.generation,
              contextVersion: (sourceRemote.contextVersion || sourceRemote.generation || 1) + 1,
              messages: input.messages,
              compressedMessages: input.messages,
              system: input.system,
              tools: input.tools || [],
              reasonCodes: routing.reasonCodes,
            });
            if (created.created) checkpoint = created.checkpoint;
          }
        }
        migration = this.migrationPlanner.plan({
          sessionId,
          sourceBackendId,
          targetBackendId: backendId,
          providerId,
          appId,
          targetCapabilities: backend.capabilities,
          checkpoint,
          canonicalContextAvailable: Array.isArray(input.messages) && input.messages.length > 0,
        });
        if (migration.blocked) {
          const error = new Error('MIGRATION_BLOCKED_NO_PORTABLE_CONTEXT');
          error.code = 'MIGRATION_BLOCKED_NO_PORTABLE_CONTEXT';
          error.routing = routing;
          error.migration = migration;
          throw error;
        }
      }

      const targetRemote = this.conversationStore.get(sessionId, providerId, appId, backendId);
      let targetGeneration = null;
      let conversationId = '';
      let messages = Array.isArray(input.messages) ? input.messages : [];

      if (backend.capabilities.contextMode === BackendContextMode.STATEFUL) {
        if (!migrationRequired && targetRemote?.conversationId) {
          conversationId = targetRemote.conversationId;
        } else if (migrationRequired) {
          assertNoCrossBackendConversationReuse({ sourceBackendId, targetBackendId: backendId, conversationId: '' });
          targetGeneration = this.conversationStore.createNextGeneration({
            dshConversationId: sessionId,
            providerId,
            difyAppId: appId,
            backendId,
            checkpointId: checkpoint?.checkpointId,
            contextVersion: checkpoint?.contextVersion,
          });
          conversationId = '';
          if (checkpoint) messages = this.migrationPlanner.bootstrapMessages({ checkpoint, builder: this.checkpointManager.builder });
        }
      }

      const replayMessages = toolReplayMessages(this.toolLedger, input.completedToolInputs || []);
      if (replayMessages.length) messages = [...messages, ...replayMessages];

      attempted.push(backendId);
      try {
        const result = await this.executor.execute({
          backend,
          credentials: await this.credentialsResolver(backend),
          messages,
          tools: input.tools || [],
          user: input.user || sessionId,
          conversationId,
          stream: input.stream,
          signal: input.signal,
        });
        this.healthStore?.recordSuccess?.(backendId);

        if (backend.capabilities.contextMode === BackendContextMode.STATEFUL) {
          if (!result.conversationId) {
            const error = new Error('MIGRATION_MISSING_TARGET_CONVERSATION_ID');
            error.code = 'MIGRATION_MISSING_TARGET_CONVERSATION_ID';
            throw error;
          }
          if (migrationRequired) {
            this.conversationStore.activateGeneration({
              dshConversationId: sessionId,
              providerId,
              difyAppId: appId,
              backendId,
              generation: targetGeneration.generation,
              conversationId: result.conversationId,
              extra: { checkpointId: checkpoint?.checkpointId || null, contextVersion: checkpoint?.contextVersion },
            });
          } else if (targetRemote?.conversationId) {
            if (targetRemote.conversationId !== result.conversationId) throw new Error('ACTIVE_GENERATION_CONVERSATION_ID_IMMUTABLE');
          } else {
            this.conversationStore.set(sessionId, providerId, appId, {
              backendId,
              conversationId: result.conversationId,
              checkpointId: checkpoint?.checkpointId,
              contextVersion: checkpoint?.contextVersion,
            });
          }
        }

        this.affinityStore.set(sessionId, providerId, appId, backendId);
        return Object.freeze({
          ...result,
          routing: Object.freeze({
            selectedBackend: backendId,
            previousBackend: currentBackendId,
            migrationRequired,
            reasonCodes: routing.reasonCodes,
            fallbackChain: routing.fallbackChain,
            fallbackUsed,
            policyVersion: routing.policyVersion,
            backendHealth: this.healthStore?.get?.(backendId) || { state: BackendHealthState.HEALTHY },
          }),
          migration: Object.freeze({
            started: migrationRequired,
            success: migrationRequired,
            failureReason: null,
            sourceBackendId: sourceBackendId || null,
            targetBackendId: backendId,
            checkpointId: checkpoint?.checkpointId || null,
            bootstrapRequired: migration.bootstrapRequired === true,
            targetGeneration: targetGeneration?.generation || null,
          }),
          attemptedBackends: Object.freeze([...attempted]),
        });
      } catch (error) {
        lastError = error;
        if (targetGeneration) {
          this.conversationStore.invalidateGeneration({
            dshConversationId: sessionId,
            providerId,
            difyAppId: appId,
            backendId,
            generation: targetGeneration.generation,
            reason: error?.code || error?.name || 'MIGRATION_FAILED',
          });
        }
        this.healthStore?.recordFailure?.(backendId, { timeout: String(error?.code || '').toUpperCase().includes('TIMEOUT') });
        if (!isFallbackEligible(error) || index === candidates.length - 1) {
          error.routing = {
            selectedBackend: backendId,
            previousBackend: currentBackendId,
            migrationRequired,
            reasonCodes: routing.reasonCodes,
            fallbackChain: routing.fallbackChain,
            fallbackUsed,
          };
          error.migration = {
            started: migrationRequired,
            success: false,
            failureReason: String(error?.code || error?.name || 'BACKEND_ERROR'),
            sourceBackendId,
            targetBackendId: backendId,
          };
          throw error;
        }
      }
    }
    throw lastError || new Error('NO_BACKEND_EXECUTED');
  }
}
