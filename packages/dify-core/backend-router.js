import { BackendCostTier } from './backend-registry.js';
import { BackendHealthState } from './backend-health.js';

export const ROUTING_POLICY_VERSION = 'deterministic-backend-router-v1';

const COST_RANK = Object.freeze({ low: 0, medium: 1, high: 2 });
const HEALTH_RANK = Object.freeze({ HEALTHY: 0, DEGRADED: 1, UNAVAILABLE: 2 });

function healthOf(backendId, backendHealth) {
  if (!backendHealth) return { backendId, state: BackendHealthState.HEALTHY, recentFailureRate: 0, timeoutRate: 0, consecutiveFailures: 0 };
  if (typeof backendHealth.get === 'function') return backendHealth.get(backendId);
  return backendHealth[backendId] || { backendId, state: BackendHealthState.HEALTHY, recentFailureRate: 0, timeoutRate: 0, consecutiveFailures: 0 };
}

function compatibility(backend, input) {
  const c = backend.capabilities;
  const reasons = [];
  if (input.requiresTools && !c.supportsTools) reasons.push('CAPABILITY_TOOLS_REQUIRED');
  if (input.hasImages && !c.supportsVision) reasons.push('CAPABILITY_VISION_REQUIRED');
  if (input.reasoningRequired && !c.supportsReasoning) reasons.push('CAPABILITY_REASONING_REQUIRED');
  if (input.streamingRequired && !c.supportsStreaming) reasons.push('CAPABILITY_STREAMING_REQUIRED');
  if (Number.isFinite(Number(input.estimatedTokens)) && c.maxContextWindow !== undefined && Number(input.estimatedTokens) > c.maxContextWindow) reasons.push('CONTEXT_LIMIT');
  return { compatible: reasons.length === 0, reasons };
}

function compareCandidates(a, b, input) {
  const ah = HEALTH_RANK[a.health.state] ?? 9;
  const bh = HEALTH_RANK[b.health.state] ?? 9;
  if (ah !== bh) return ah - bh;

  const simpleLowCost = input.taskType === 'simple' && !input.requiresTools && !input.hasImages && !input.reasoningRequired && Number(input.contextUtilization || 0) < 0.35;
  if (simpleLowCost || input.budgetTier === BackendCostTier.LOW) {
    const ac = COST_RANK[a.backend.capabilities.costTier] ?? 9;
    const bc = COST_RANK[b.backend.capabilities.costTier] ?? 9;
    if (ac !== bc) return ac - bc;
  }

  if (input.latencyTarget === 'low' && a.backend.priority !== b.backend.priority) return a.backend.priority - b.backend.priority;

  const aw = a.backend.capabilities.maxContextWindow ?? Number.MAX_SAFE_INTEGER;
  const bw = b.backend.capabilities.maxContextWindow ?? Number.MAX_SAFE_INTEGER;
  if (Number.isFinite(Number(input.estimatedTokens)) && aw !== bw) return aw - bw;
  if (a.backend.priority !== b.backend.priority) return a.backend.priority - b.backend.priority;
  const ac = COST_RANK[a.backend.capabilities.costTier] ?? 9;
  const bc = COST_RANK[b.backend.capabilities.costTier] ?? 9;
  if (ac !== bc) return ac - bc;
  return a.backend.backendId.localeCompare(b.backend.backendId);
}

export class DeterministicBackendRouter {
  constructor({ registry, healthStore, policyVersion = ROUTING_POLICY_VERSION } = {}) {
    if (!registry) throw new Error('BACKEND_REGISTRY_REQUIRED');
    this.registry = registry;
    this.healthStore = healthStore;
    this.policyVersion = policyVersion;
  }

  decide(input = {}) {
    const enabled = this.registry.list({ enabledOnly: true });
    const evaluated = enabled.map((backend) => ({
      backend,
      health: healthOf(backend.backendId, input.backendHealth || this.healthStore),
      compatibility: compatibility(backend, input),
    }));

    const current = input.currentBackendId ? evaluated.find((x) => x.backend.backendId === input.currentBackendId) : null;
    if (current && current.compatibility.compatible && current.health.state !== BackendHealthState.UNAVAILABLE && input.explicitBackendId === undefined) {
      const fallbacks = evaluated
        .filter((x) => x.backend.backendId !== current.backend.backendId && x.compatibility.compatible && x.health.state !== BackendHealthState.UNAVAILABLE)
        .sort((a, b) => compareCandidates(a, b, input))
        .map((x) => x.backend.backendId);
      return Object.freeze({
        backendId: current.backend.backendId,
        model: current.backend.model,
        migrationRequired: false,
        fallbackChain: Object.freeze(fallbacks),
        reasonCodes: Object.freeze(['SESSION_AFFINITY', current.health.state === BackendHealthState.DEGRADED ? 'CURRENT_BACKEND_DEGRADED_BUT_USABLE' : 'CURRENT_BACKEND_HEALTHY']),
        policyVersion: this.policyVersion,
      });
    }

    const explicit = input.explicitBackendId
      ? evaluated.find((x) => x.backend.backendId === input.explicitBackendId && x.compatibility.compatible && x.health.state !== BackendHealthState.UNAVAILABLE)
      : null;
    const viable = evaluated
      .filter((x) => x.compatibility.compatible && x.health.state !== BackendHealthState.UNAVAILABLE)
      .sort((a, b) => compareCandidates(a, b, input));
    const selected = explicit || viable[0];
    if (!selected) {
      const reasons = ['NO_COMPATIBLE_BACKEND'];
      if (current?.health.state === BackendHealthState.UNAVAILABLE) reasons.push('BACKEND_UNAVAILABLE');
      if (current?.compatibility.reasons?.length) reasons.push(...current.compatibility.reasons);
      return Object.freeze({ backendId: null, model: undefined, migrationRequired: false, fallbackChain: Object.freeze([]), reasonCodes: Object.freeze([...new Set(reasons)]), policyVersion: this.policyVersion });
    }

    const reasons = [];
    if (input.explicitBackendId) reasons.push('EXPLICIT_POLICY');
    if (current) {
      if (current.health.state === BackendHealthState.UNAVAILABLE) reasons.push('BACKEND_UNAVAILABLE');
      if (current.compatibility.reasons.includes('CONTEXT_LIMIT')) reasons.push('CONTEXT_LIMIT');
      if (current.compatibility.reasons.some((x) => x.startsWith('CAPABILITY_'))) reasons.push('CAPABILITY_MISMATCH', ...current.compatibility.reasons);
    } else reasons.push('INITIAL_BACKEND_SELECTION');
    if (selected.backend.capabilities.costTier === BackendCostTier.LOW && input.taskType === 'simple' && !input.requiresTools && !input.hasImages) reasons.push('LOW_COST_SIMPLE_TASK');

    const fallbackChain = viable.filter((x) => x.backend.backendId !== selected.backend.backendId).map((x) => x.backend.backendId);
    return Object.freeze({
      backendId: selected.backend.backendId,
      model: selected.backend.model,
      migrationRequired: Boolean(current && current.backend.backendId !== selected.backend.backendId),
      fallbackChain: Object.freeze(fallbackChain),
      reasonCodes: Object.freeze([...new Set(reasons)]),
      policyVersion: this.policyVersion,
    });
  }
}

export function isFallbackEligible(error = {}) {
  const status = Number(error.status || error.statusCode);
  const code = String(error.code || error.name || '').toUpperCase();
  return code.includes('TIMEOUT') || code === 'BACKEND_UNAVAILABLE' || (Number.isFinite(status) && status >= 500 && status <= 599);
}
