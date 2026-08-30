import { BackendContextMode, BackendRegistry } from './backend-registry.js';
import { BackendHealthState } from './backend-health.js';
import { DeterministicBackendRouter, isFallbackEligible } from './backend-router.js';
import { assertNoCrossBackendConversationReuse } from './context-migration.js';
import { ToolSchemaRegistry } from './tool-schema-registry.js';
import {
  ToolPruner,
  ToolRecovery,
  ToolRelevancePolicy,
  ToolSchemaCostEstimator,
  ToolUsageProfiler,
} from './tool-optimization.js';

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

function statefulDeltaMessages(messages = []) {
  if (!Array.isArray(messages) || messages.length === 0) return [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'assistant') return messages.slice(i + 1);
  }
  const nonInstructions = messages.filter((message) => message?.role !== 'system' && message?.role !== 'developer');
  return nonInstructions.length ? nonInstructions : messages;
}

function hasToolResult(messages = [], toolCallId) {
  const id = String(toolCallId || '');
  return messages.some((message) => message?.role === 'tool' && String(message?.tool_call_id || '') === id);
}

function toolReplayMessages(ledger, requests = [], existingMessages = []) {
  const out = [];
  for (const input of requests) {
    if (hasToolResult(existingMessages, input.toolCallId)) continue;
    const entry = ledger?.get?.(input);
    if (entry?.status === 'completed' || entry?.status === 'result_forwarded') {
      out.push({ role: 'tool', tool_call_id: input.toolCallId, content: String(entry.result ?? '') });
    }
  }
  return out;
}

function policyRegistry(baseRegistry, policyConfig = {}) {
  const priorities = policyConfig.backendPriority || {};
  if (!Object.keys(priorities).length) return baseRegistry;
  const entries = baseRegistry.list({ enabledOnly: false }).map((backend) => ({
    backendId: backend.backendId,
    providerType: backend.providerType,
    baseUrl: backend.baseUrl,
    model: backend.model,
    enabled: backend.enabled,
    priority: priorities[backend.backendId] ?? backend.priority,
    credentialEnv: backend.credentialEnv,
    maxContextWindow: backend.capabilities.maxContextWindow,
    supportsTools: backend.capabilities.supportsTools,
    supportsVision: backend.capabilities.supportsVision,
    supportsStreaming: backend.capabilities.supportsStreaming,
    supportsReasoning: backend.capabilities.supportsReasoning,
    statefulContext: backend.capabilities.contextMode === BackendContextMode.STATEFUL,
    costTier: backend.capabilities.costTier,
  }));
  return new BackendRegistry(entries);
}

function policyHealthView(healthStore, policyConfig = {}) {
  const overrides = policyConfig.backendHealth || {};
  if (!healthStore || !Object.keys(overrides).length) return healthStore;
  const baseConfig = healthStore.config || {};
  const config = { ...baseConfig, ...overrides };
  return Object.freeze({
    get(backendId) {
      const snapshot = healthStore.get(backendId);
      let state;
      if (snapshot.consecutiveFailures >= Number(config.unavailableConsecutiveFailures ?? 3)
        || (snapshot.sampleCount >= Number(config.minimumSamples ?? 4) && snapshot.recentFailureRate >= Number(config.unavailableFailureRate ?? 0.60))) {
        state = BackendHealthState.UNAVAILABLE;
      } else if (snapshot.sampleCount >= Number(config.minimumSamples ?? 4)
        && (snapshot.recentFailureRate >= Number(config.degradedFailureRate ?? 0.25)
          || snapshot.timeoutRate >= Number(config.degradedTimeoutRate ?? 0.20))) {
        state = BackendHealthState.DEGRADED;
      } else {
        state = BackendHealthState.HEALTHY;
      }
      return Object.freeze({ ...snapshot, state });
    },
  });
}

export class AdaptiveBackendGateway {
  constructor({
    registry, router, migrationPlanner, conversationStore, checkpointManager, healthStore, toolLedger, executor,
    affinityStore, credentialsResolver, toolUsageProfiler, toolSchemaCostEstimator, toolRelevancePolicy,
    toolPruner, toolRecovery, toolSchemaRegistry,
  } = {}) {
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
    this.toolUsageProfiler = toolUsageProfiler || new ToolUsageProfiler();
    this.toolSchemaCostEstimator = toolSchemaCostEstimator || new ToolSchemaCostEstimator();
    this.toolRelevancePolicy = toolRelevancePolicy || new ToolRelevancePolicy();
    this.toolPruner = toolPruner || new ToolPruner({ estimator: this.toolSchemaCostEstimator });
    this.toolRecovery = toolRecovery || new ToolRecovery({ maxRecoveries: 1 });
    this.toolSchemaRegistry = toolSchemaRegistry || new ToolSchemaRegistry();
  }

  async execute(input = {}) {
    const sessionId = String(input.sessionId || '');
    if (!sessionId) throw new Error('GATEWAY_SESSION_REQUIRED');
    const providerId = String(input.providerId || 'gateway');
    const appId = String(input.appId || 'default');
    const requestMessages = Array.isArray(input.messages) ? input.messages : [];
    const canonicalMessages = Array.isArray(input.canonicalMessages) && input.canonicalMessages.length
      ? input.canonicalMessages
      : requestMessages;
    const availableTools = Array.isArray(input.tools) ? input.tools : [];
    const currentBackendId = input.currentBackendId || this.affinityStore.get(sessionId, providerId, appId) || null;
    const selectedPolicyVersion = String(input.policyVersion || this.router.policyVersion || 'deterministic-backend-router-v1');
    const selectedPolicyConfig = input.policyConfig || {};
    const routingRegistry = policyRegistry(this.registry, selectedPolicyConfig);
    const routingHealth = policyHealthView(this.healthStore, selectedPolicyConfig);
    const router = routingRegistry === this.registry && routingHealth === this.healthStore && !input.policyVersion
      ? this.router
      : new DeterministicBackendRouter({ registry: routingRegistry, healthStore: routingHealth, policyVersion: selectedPolicyVersion });
    const routing = router.decide({ ...input, currentBackendId, backendHealth: routingHealth });
    if (!routing.backendId) {
      const error = new Error('NO_COMPATIBLE_BACKEND');
      error.code = 'NO_COMPATIBLE_BACKEND';
      error.routing = routing;
      throw error;
    }

    const toolConfidenceThreshold = Number(selectedPolicyConfig.tool?.pruningConfidenceThreshold);
    const toolRelevancePolicy = Number.isFinite(toolConfidenceThreshold)
      ? new ToolRelevancePolicy({ pruningConfidenceThreshold: toolConfidenceThreshold })
      : this.toolRelevancePolicy;
    const recoveryLimit = Number(selectedPolicyConfig.tool?.recoveryLimit);
    const toolRecovery = Number.isFinite(recoveryLimit)
      ? new ToolRecovery({ maxRecoveries: recoveryLimit })
      : this.toolRecovery;

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
        if (!checkpoint && this.checkpointManager && canonicalMessages.length) {
          const sourceRemote = this.conversationStore.get(sessionId, providerId, appId, sourceBackendId);
          if (sourceRemote) {
            const created = this.checkpointManager.create({
              sessionId,
              backendId: sourceBackendId,
              providerId,
              appId,
              sourceGeneration: sourceRemote.generation,
              contextVersion: (sourceRemote.contextVersion || sourceRemote.generation || 1) + 1,
              messages: canonicalMessages,
              compressedMessages: requestMessages,
              system: input.system,
              tools: availableTools,
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
          canonicalContextAvailable: canonicalMessages.length > 0,
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
      let messages = backend.capabilities.contextMode === BackendContextMode.STATELESS ? canonicalMessages : requestMessages;

      if (backend.capabilities.contextMode === BackendContextMode.STATEFUL) {
        if (!migrationRequired && targetRemote?.conversationId) {
          conversationId = targetRemote.conversationId;
          messages = statefulDeltaMessages(requestMessages);
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
          else messages = canonicalMessages;
        }
      }

      const replayMessages = toolReplayMessages(this.toolLedger, input.completedToolInputs || [], messages);
      if (replayMessages.length) messages = [...messages, ...replayMessages];

      const generation = targetGeneration?.generation ?? targetRemote?.generation ?? (backend.capabilities.contextMode === BackendContextMode.STATEFUL ? 1 : 'stateless');
      const scope = { sessionId, clientType: String(input.clientType || ''), backendId };
      const fullCost = this.toolSchemaCostEstimator.summarize(availableTools);
      const priorProfile = this.toolUsageProfiler.recordRequest(scope, {
        tools: availableTools,
        schemaTokens: fullCost.beforeSchemaTokens,
        pendingTools: input.pendingTools || [],
      });
      for (const completed of input.completedToolInputs || []) {
        if (completed.toolName) this.toolUsageProfiler.recordOutcome(scope, { toolName: completed.toolName, success: true });
      }
      const policyResult = toolRelevancePolicy.classify({
        canonicalRequest: { clientType: input.clientType, taskType: input.taskType },
        tools: availableTools,
        profile: priorProfile,
        backendCapabilities: backend.capabilities,
        taskHints: input.taskHints || [],
        explicitRequiredTools: input.requiredTools || [],
        messages: canonicalMessages,
      });
      const pruning = this.toolPruner.prune({
        canonicalRequest: { clientType: input.clientType, taskType: input.taskType },
        availableTools,
        profile: priorProfile,
        policyResult,
      });
      const schemaState = this.toolSchemaRegistry.resolve({
        dshConversationId: sessionId,
        providerId,
        difyAppId: appId,
        backendId,
        generation,
        tools: pruning.selectedTools,
      });
      const toolOptimization = {
        ...pruning,
        selectedTools: undefined,
        schemaReinjectionRequired: schemaState.reinjectionRequired,
        schemaHash: schemaState.toolSchemaHash,
        recoveryTriggered: false,
        recoveryReason: null,
        recoverySuccess: false,
      };

      attempted.push(backendId);
      try {
        const credentials = await this.credentialsResolver(backend);
        let result;
        let recoveryCount = 0;
        try {
          result = await this.executor.execute({
            backend,
            credentials,
            messages,
            tools: pruning.selectedTools,
            user: input.user || sessionId,
            conversationId,
            stream: input.stream,
            signal: input.signal,
          });
        } catch (firstError) {
          if (!toolRecovery.shouldRecover({ error: firstError, pruningResult: pruning, recoveryCount })) throw firstError;
          recoveryCount += 1;
          const recovery = toolRecovery.decision(firstError);
          toolOptimization.recoveryTriggered = true;
          toolOptimization.recoveryReason = recovery.reason;
          this.toolSchemaRegistry.resolve({
            dshConversationId: sessionId,
            providerId,
            difyAppId: appId,
            backendId,
            generation,
            tools: availableTools,
          });
          result = await this.executor.execute({
            backend,
            credentials,
            messages,
            tools: availableTools,
            user: input.user || sessionId,
            conversationId,
            stream: input.stream,
            signal: input.signal,
          });
          toolOptimization.recoverySuccess = true;
        }
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
          toolOptimization: Object.freeze(toolOptimization),
          routing: Object.freeze({
            selectedBackend: backendId,
            previousBackend: currentBackendId,
            migrationRequired,
            reasonCodes: routing.reasonCodes,
            fallbackChain: routing.fallbackChain,
            fallbackUsed,
            policyVersion: selectedPolicyVersion,
            backendHealth: routingHealth?.get?.(backendId) || { state: BackendHealthState.HEALTHY },
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
            policyVersion: selectedPolicyVersion,
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
