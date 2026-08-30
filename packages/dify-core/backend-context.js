function tokenNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function normalizedUsage(prompt, completion) {
  const backendPromptTokens = tokenNumber(prompt);
  const backendCompletionTokens = tokenNumber(completion);
  if (backendPromptTokens === undefined && backendCompletionTokens === undefined) return undefined;
  return Object.freeze({
    ...(backendPromptTokens === undefined ? {} : { backendPromptTokens }),
    ...(backendCompletionTokens === undefined ? {} : { backendCompletionTokens }),
  });
}

export class GenericOpenAIUsageExtractor {
  extract(payload) {
    const usage = payload?.usage || payload?.metadata?.usage;
    if (!usage || typeof usage !== 'object') return undefined;
    return normalizedUsage(
      usage.prompt_tokens ?? usage.input_tokens,
      usage.completion_tokens ?? usage.output_tokens,
    );
  }
}

export class DifyUsageExtractor {
  extract(payload) {
    const usage = payload?.metadata?.usage || payload?.usage;
    if (!usage || typeof usage !== 'object') return undefined;
    return normalizedUsage(
      usage.prompt_tokens ?? usage.input_tokens,
      usage.completion_tokens ?? usage.output_tokens,
    );
  }
}

export class BackendUsageExtractor {
  constructor(options = {}) {
    this.generic = options.generic || new GenericOpenAIUsageExtractor();
    this.dify = options.dify || new DifyUsageExtractor();
  }

  extract(payload, backendType = 'generic-openai') {
    return backendType === 'dify' ? this.dify.extract(payload) : this.generic.extract(payload);
  }
}

export function reconcileBackendContext({
  gatewayEstimatedInputTokens,
  gatewayCompressedTokens,
  backendPromptTokens,
  backendCompletionTokens,
  backendContextWindow,
}) {
  const estimated = tokenNumber(gatewayEstimatedInputTokens) ?? 0;
  const compressed = tokenNumber(gatewayCompressedTokens) ?? estimated;
  const backendPrompt = tokenNumber(backendPromptTokens);
  const backendCompletion = tokenNumber(backendCompletionTokens);
  const contextWindow = tokenNumber(backendContextWindow);
  const contextAmplification = backendPrompt === undefined ? undefined : backendPrompt / Math.max(compressed, 1);
  const backendContextUtilization = backendPrompt === undefined || !contextWindow
    ? undefined
    : backendPrompt / contextWindow;
  return Object.freeze({
    gatewayEstimatedInputTokens: estimated,
    gatewayCompressedTokens: compressed,
    ...(backendPrompt === undefined ? {} : { backendPromptTokens: backendPrompt }),
    ...(backendCompletion === undefined ? {} : { backendCompletionTokens: backendCompletion }),
    ...(contextAmplification === undefined ? {} : { contextAmplification }),
    ...(backendContextUtilization === undefined ? {} : { backendContextUtilization }),
  });
}

export const DEFAULT_CHECKPOINT_RECOMMENDATION_CONFIG = Object.freeze({
  amplificationThreshold: 2.0,
  backendContextUtilizationThreshold: 0.90,
});

function finiteNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function checkpointRecommendationConfigFromEnv(env = process.env) {
  return {
    amplificationThreshold: finiteNumber(env.GATEWAY_CHECKPOINT_AMPLIFICATION_THRESHOLD, DEFAULT_CHECKPOINT_RECOMMENDATION_CONFIG.amplificationThreshold),
    backendContextUtilizationThreshold: finiteNumber(env.GATEWAY_CHECKPOINT_BACKEND_UTILIZATION_THRESHOLD, DEFAULT_CHECKPOINT_RECOMMENDATION_CONFIG.backendContextUtilizationThreshold),
  };
}

export class CheckpointRecommendation {
  constructor(options = {}) {
    this.config = Object.freeze({ ...DEFAULT_CHECKPOINT_RECOMMENDATION_CONFIG, ...options.config });
    if (!(this.config.amplificationThreshold > 0)) throw new Error('amplificationThreshold must be positive');
    if (!(this.config.backendContextUtilizationThreshold > 0)) throw new Error('backendContextUtilizationThreshold must be positive');
  }

  recommend({ compressionResult, reconciliation }) {
    const reasons = [];
    if (compressionResult?.unableToReachTarget === true) reasons.push('compression_target_unreachable');
    if (reconciliation?.contextAmplification !== undefined && reconciliation.contextAmplification >= this.config.amplificationThreshold) {
      reasons.push('backend_context_amplification_high');
    }
    if (reconciliation?.backendContextUtilization !== undefined
      && reconciliation.backendContextUtilization >= this.config.backendContextUtilizationThreshold) {
      reasons.push('backend_context_utilization_high');
    }
    return Object.freeze({ recommended: reasons.length > 0, reasonCodes: Object.freeze(reasons) });
  }
}
