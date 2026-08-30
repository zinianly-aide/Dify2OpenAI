import { canonicalJson, sha256 } from './canonical.js';

export const ToolRelevance = Object.freeze({ REQUIRED: 'REQUIRED', LIKELY: 'LIKELY', OPTIONAL: 'OPTIONAL', DISABLED: 'DISABLED' });
export const ToolPruningMode = Object.freeze({ SEND_ALL: 'SEND_ALL', PRUNED: 'PRUNED' });

export function toolNameOf(tool) {
  return String(tool?.function?.name || tool?.name || '').trim();
}

function toolDescription(tool) {
  return String(tool?.function?.description || tool?.description || '').toLowerCase();
}

function words(value) {
  return new Set(String(value || '').toLowerCase().split(/[^a-z0-9_\-]+/).filter((v) => v.length >= 3));
}

function intersects(a, b) {
  for (const item of a) if (b.has(item)) return true;
  return false;
}

export class ToolSchemaCostEstimator {
  estimate(tool) {
    const canonical = canonicalJson(tool ?? {});
    return Object.freeze({
      toolName: toolNameOf(tool),
      schemaHash: sha256(canonical),
      estimatedTokens: Math.max(1, Math.ceil(canonical.length / 4)),
    });
  }

  summarize(tools = []) {
    const estimates = tools.map((tool) => this.estimate(tool));
    return Object.freeze({
      tools: Object.freeze(estimates),
      beforeToolCount: tools.length,
      beforeSchemaTokens: estimates.reduce((sum, item) => sum + item.estimatedTokens, 0),
    });
  }
}

export class ToolUsageProfiler {
  constructor({ recentLimit = 8 } = {}) {
    this.recentLimit = recentLimit;
    this.profiles = new Map();
  }

  key({ sessionId, clientType = '', backendId = '' }) {
    return `${sessionId}::${clientType}::${backendId}`;
  }

  get(scope) {
    const value = this.profiles.get(this.key(scope));
    if (value) return Object.freeze({ ...value, recentlyUsedTools: [...value.recentlyUsedTools], pendingTools: [...value.pendingTools], toolUsageFrequency: { ...value.toolUsageFrequency } });
    return Object.freeze({
      toolCount: 0,
      toolSchemaTokens: 0,
      toolUsageFrequency: {},
      toolSuccessRate: 0,
      toolFailureRate: 0,
      recentlyUsedTools: [],
      pendingTools: [],
      successfulCalls: 0,
      failedCalls: 0,
      totalCalls: 0,
    });
  }

  recordRequest(scope, { tools = [], schemaTokens = 0, pendingTools = [] } = {}) {
    const current = this.get(scope);
    this.profiles.set(this.key(scope), {
      ...current,
      toolCount: tools.length,
      toolSchemaTokens: schemaTokens,
      recentlyUsedTools: [...current.recentlyUsedTools],
      pendingTools: [...new Set(pendingTools.map(String))].sort(),
      toolUsageFrequency: { ...current.toolUsageFrequency },
    });
    return this.get(scope);
  }

  recordOutcome(scope, { toolName, success } = {}) {
    if (!toolName) return this.get(scope);
    const current = this.get(scope);
    const successfulCalls = current.successfulCalls + (success ? 1 : 0);
    const failedCalls = current.failedCalls + (success ? 0 : 1);
    const totalCalls = successfulCalls + failedCalls;
    const frequency = { ...current.toolUsageFrequency, [toolName]: (current.toolUsageFrequency[toolName] || 0) + 1 };
    const recent = [toolName, ...current.recentlyUsedTools.filter((name) => name !== toolName)].slice(0, this.recentLimit);
    this.profiles.set(this.key(scope), {
      ...current,
      successfulCalls,
      failedCalls,
      totalCalls,
      toolSuccessRate: totalCalls ? successfulCalls / totalCalls : 0,
      toolFailureRate: totalCalls ? failedCalls / totalCalls : 0,
      toolUsageFrequency: frequency,
      recentlyUsedTools: recent,
    });
    return this.get(scope);
  }
}

function pendingToolNames(messages = []) {
  const calls = new Map();
  const completed = new Set();
  for (const message of messages) {
    for (const call of message?.tool_calls || []) {
      const name = String(call?.function?.name || call?.name || '');
      if (call?.id && name) calls.set(String(call.id), name);
    }
    if (message?.role === 'tool' && message?.tool_call_id) completed.add(String(message.tool_call_id));
  }
  return [...calls.entries()].filter(([id]) => !completed.has(id)).map(([, name]) => name);
}

export class ToolRelevancePolicy {
  constructor({ requiredCoreTools = [], criticalTools = [], clientRequiredTools = {}, categoryHints = {} } = {}) {
    this.requiredCoreTools = new Set(requiredCoreTools.map(String));
    this.criticalTools = new Set(criticalTools.map(String));
    this.clientRequiredTools = clientRequiredTools;
    this.categoryHints = categoryHints;
  }

  classify({ canonicalRequest = {}, tools = [], profile = {}, backendCapabilities = {}, taskHints = [], explicitRequiredTools = [], messages = [] } = {}) {
    if (backendCapabilities.supportsTools === false) {
      return Object.freeze({ confidence: 'high', classifications: tools.map((tool) => ({ toolName: toolNameOf(tool), relevance: ToolRelevance.DISABLED, reasonCodes: ['BACKEND_TOOLS_UNSUPPORTED'] })) });
    }
    const pending = new Set([...(profile.pendingTools || []), ...pendingToolNames(messages)].map(String));
    const recent = new Set((profile.recentlyUsedTools || []).map(String));
    const required = new Set([...this.requiredCoreTools, ...explicitRequiredTools.map(String), ...(this.clientRequiredTools[canonicalRequest.clientType] || [])]);
    const hintWords = words([...(Array.isArray(taskHints) ? taskHints : [taskHints]), canonicalRequest.taskType || ''].join(' '));
    const classifications = tools.map((tool) => {
      const name = toolNameOf(tool);
      const reasons = [];
      let relevance = ToolRelevance.OPTIONAL;
      if (required.has(name)) { relevance = ToolRelevance.REQUIRED; reasons.push('REQUIRED_CORE_TOOL'); }
      if (pending.has(name)) { relevance = ToolRelevance.REQUIRED; reasons.push('PENDING_TOOL_CHAIN'); }
      if (recent.has(name) && this.criticalTools.has(name)) { relevance = ToolRelevance.REQUIRED; reasons.push('RECENT_CRITICAL_TOOL'); }
      const tokens = new Set([...words(name), ...words(toolDescription(tool)), ...words(this.categoryHints[name] || '')]);
      if (hintWords.size && intersects(hintWords, tokens)) {
        relevance = ToolRelevance.REQUIRED;
        reasons.push('CURRENT_TASK_HINT');
      } else if (relevance === ToolRelevance.OPTIONAL && recent.has(name)) {
        relevance = ToolRelevance.LIKELY;
        reasons.push('RECENTLY_USED');
      } else if (relevance === ToolRelevance.OPTIONAL && Number(profile.toolUsageFrequency?.[name] || 0) > 0) {
        relevance = ToolRelevance.LIKELY;
        reasons.push('HISTORICALLY_USED');
      }
      return Object.freeze({ toolName: name, relevance, reasonCodes: Object.freeze(reasons) });
    });
    const hasSignal = classifications.some((item) => item.relevance === ToolRelevance.REQUIRED || item.relevance === ToolRelevance.LIKELY);
    return Object.freeze({ confidence: hasSignal ? 'high' : 'low', classifications: Object.freeze(classifications) });
  }
}

export class ToolPruner {
  constructor({ estimator = new ToolSchemaCostEstimator(), minimumKeep = 1 } = {}) {
    this.estimator = estimator;
    this.minimumKeep = minimumKeep;
  }

  prune({ canonicalRequest = {}, availableTools = [], profile = {}, policyResult } = {}) {
    const before = this.estimator.summarize(availableTools);
    const classifications = new Map((policyResult?.classifications || []).map((item) => [item.toolName, item]));
    if (!availableTools.length || policyResult?.confidence !== 'high') {
      return Object.freeze({
        selectedTools: Object.freeze([...availableTools]), removedTools: Object.freeze([]),
        beforeToolCount: before.beforeToolCount, afterToolCount: before.beforeToolCount,
        beforeSchemaTokens: before.beforeSchemaTokens, afterSchemaTokens: before.beforeSchemaTokens,
        savedTokens: 0, confidence: policyResult?.confidence || 'low', mode: ToolPruningMode.SEND_ALL,
        reasonCodes: Object.freeze(['LOW_CONFIDENCE_SEND_ALL']),
      });
    }
    const selected = availableTools.filter((tool) => {
      const relevance = classifications.get(toolNameOf(tool))?.relevance;
      return relevance === ToolRelevance.REQUIRED || relevance === ToolRelevance.LIKELY;
    });
    if (selected.length < this.minimumKeep) {
      return Object.freeze({
        selectedTools: Object.freeze([...availableTools]), removedTools: Object.freeze([]),
        beforeToolCount: before.beforeToolCount, afterToolCount: before.beforeToolCount,
        beforeSchemaTokens: before.beforeSchemaTokens, afterSchemaTokens: before.beforeSchemaTokens,
        savedTokens: 0, confidence: 'low', mode: ToolPruningMode.SEND_ALL,
        reasonCodes: Object.freeze(['INSUFFICIENT_RELEVANCE_SIGNAL_SEND_ALL']),
      });
    }
    const selectedNames = new Set(selected.map(toolNameOf));
    const removed = availableTools.filter((tool) => !selectedNames.has(toolNameOf(tool)));
    const after = this.estimator.summarize(selected);
    return Object.freeze({
      selectedTools: Object.freeze(selected), removedTools: Object.freeze(removed.map(toolNameOf)),
      beforeToolCount: before.beforeToolCount, afterToolCount: selected.length,
      beforeSchemaTokens: before.beforeSchemaTokens, afterSchemaTokens: after.beforeSchemaTokens,
      savedTokens: Math.max(0, before.beforeSchemaTokens - after.beforeSchemaTokens),
      confidence: policyResult.confidence, mode: removed.length ? ToolPruningMode.PRUNED : ToolPruningMode.SEND_ALL,
      reasonCodes: Object.freeze(removed.length ? ['DETERMINISTIC_RELEVANCE_PRUNE'] : ['NO_SAFE_PRUNING_OPPORTUNITY']),
    });
  }
}

export function isMissingToolCondition(error) {
  const code = String(error?.code || '').toUpperCase();
  if (code === 'MISSING_TOOL' || code === 'TOOL_NOT_FOUND' || code === 'UNKNOWN_TOOL') return true;
  const message = String(error?.message || '').toLowerCase();
  return /unknown tool|tool not found|missing required tool|missing tool/.test(message);
}

export class ToolRecovery {
  constructor({ maxRecoveries = 1 } = {}) { this.maxRecoveries = Math.max(0, Number(maxRecoveries) || 0); }
  shouldRecover({ error, pruningResult, recoveryCount = 0 } = {}) {
    return Boolean(pruningResult?.mode === ToolPruningMode.PRUNED && recoveryCount < this.maxRecoveries && isMissingToolCondition(error));
  }
  decision(error) {
    return Object.freeze({ mode: 'RECOVER_FULL_TOOLSET', reason: String(error?.code || 'MISSING_TOOL_CONDITION') });
  }
}
