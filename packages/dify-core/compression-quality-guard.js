import { CompressionResult } from './context-compressor.js';

export const DEFAULT_COMPRESSION_QUALITY_CONFIG = Object.freeze({
  targetUtilization: 0.68,
  maxCompressionPasses: 2,
  minimumSavingsRatio: 0.05,
});

function finiteNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function positiveInteger(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function compressionQualityConfigFromEnv(env = process.env) {
  return {
    targetUtilization: finiteNumber(env.GATEWAY_COMPRESSION_TARGET_UTILIZATION, DEFAULT_COMPRESSION_QUALITY_CONFIG.targetUtilization),
    maxCompressionPasses: positiveInteger(env.GATEWAY_COMPRESSION_MAX_PASSES, DEFAULT_COMPRESSION_QUALITY_CONFIG.maxCompressionPasses),
    minimumSavingsRatio: finiteNumber(env.GATEWAY_COMPRESSION_MINIMUM_SAVINGS_RATIO, DEFAULT_COMPRESSION_QUALITY_CONFIG.minimumSavingsRatio),
  };
}

function validate(config) {
  if (!(config.targetUtilization > 0 && config.targetUtilization <= 1)) throw new Error('targetUtilization must be within (0, 1]');
  if (!(Number.isInteger(config.maxCompressionPasses) && config.maxCompressionPasses > 0)) throw new Error('maxCompressionPasses must be a positive integer');
  if (!(config.minimumSavingsRatio >= 0 && config.minimumSavingsRatio <= 1)) throw new Error('minimumSavingsRatio must be within [0, 1]');
}

function nextMode(mode) {
  if (mode === 'tool_prune') return 'light';
  if (mode === 'light') return 'heavy';
  if (mode === 'heavy') return 'heavy';
  return mode;
}

function contains(result, code) {
  return result?.reasonCodes?.includes(code);
}

function finalize(base, fields, reason) {
  return new CompressionResult({
    ...base,
    ...fields,
    reasonCodes: [...base.reasonCodes, reason],
  });
}

export class CompressionQualityGuard {
  constructor(options = {}) {
    this.config = Object.freeze({ ...DEFAULT_COMPRESSION_QUALITY_CONFIG, ...options.config });
    validate(this.config);
  }

  run({ messages = [], tools = [], system, initialProfile, compressor, profiler }) {
    const target = this.config.targetUtilization;
    const initialUtilization = initialProfile?.contextUtilization;
    if (initialUtilization !== undefined && initialUtilization <= target) {
      const first = compressor.compress({ messages, tools, system, profile: initialProfile, targetUtilization: target });
      return {
        messages: first.messages,
        profile: initialProfile,
        result: new CompressionResult({
          ...first.result,
          targetUtilization: target,
          compressionPasses: 0,
          targetReached: true,
          unableToReachTarget: false,
          reasonCodes: [...first.result.reasonCodes, 'TARGET_REACHED'],
        }),
      };
    }

    let currentMessages = messages;
    let currentProfile = initialProfile;
    let mode;
    let aggregateBefore;
    let aggregateReasonCodes = [];
    let lastResult;
    let passes = 0;

    while (passes < this.config.maxCompressionPasses) {
      const policyDecision = compressor.policy.decide(currentProfile);
      mode = mode === undefined ? policyDecision.mode : nextMode(mode);
      if (mode === 'none') {
        const noChange = compressor.compress({ messages: currentMessages, tools, system, profile: currentProfile, targetUtilization: target });
        const base = aggregateBefore === undefined ? noChange.result : new CompressionResult({
          ...noChange.result,
          beforeTokens: aggregateBefore,
          savedTokens: Math.max(0, aggregateBefore - noChange.result.afterTokens),
          compressionPasses: passes,
          reasonCodes: [...aggregateReasonCodes, ...noChange.result.reasonCodes],
        });
        return { messages: currentMessages, profile: currentProfile, result: finalize(base, { targetReached: false, unableToReachTarget: true, targetUtilization: target }, 'NOT_ENOUGH_COMPRESSIBLE_HISTORY') };
      }

      passes += 1;
      const step = compressor.compress({
        messages: currentMessages,
        tools,
        system,
        profile: currentProfile,
        modeOverride: mode,
        pass: passes,
        targetUtilization: target,
      });
      if (aggregateBefore === undefined) aggregateBefore = step.result.beforeTokens;
      aggregateReasonCodes.push(...step.result.reasonCodes);
      lastResult = step.result;
      currentMessages = step.messages;
      currentProfile = profiler.reprofile(currentProfile, {
        estimatedPromptTokens: step.result.afterTokens,
        messageCount: currentMessages.length,
      });
      const afterUtilization = currentProfile.contextUtilization;
      const savingsRatio = step.result.beforeTokens > 0 ? step.result.savedTokens / step.result.beforeTokens : 0;

      const aggregate = new CompressionResult({
        ...step.result,
        beforeTokens: aggregateBefore,
        afterTokens: step.result.afterTokens,
        savedTokens: Math.max(0, aggregateBefore - step.result.afterTokens),
        beforeUtilization: initialUtilization,
        afterUtilization,
        targetUtilization: target,
        compressionPasses: passes,
        targetReached: afterUtilization !== undefined && afterUtilization <= target,
        unableToReachTarget: false,
        reasonCodes: [...aggregateReasonCodes],
      });

      if (aggregate.targetReached) {
        return { messages: currentMessages, profile: currentProfile, result: finalize(aggregate, {}, 'TARGET_REACHED') };
      }
      if (contains(step.result, 'compression_protected_context_dominates')) {
        return { messages: currentMessages, profile: currentProfile, result: finalize(aggregate, { unableToReachTarget: true }, 'PROTECTED_CONTEXT_DOMINATES') };
      }
      if (contains(step.result, 'compression_not_enough_compressible_history')) {
        return { messages: currentMessages, profile: currentProfile, result: finalize(aggregate, { unableToReachTarget: true }, 'NOT_ENOUGH_COMPRESSIBLE_HISTORY') };
      }
      if (savingsRatio < this.config.minimumSavingsRatio) {
        return { messages: currentMessages, profile: currentProfile, result: finalize(aggregate, { unableToReachTarget: true }, 'NO_MEANINGFUL_SAVINGS') };
      }
    }

    const result = new CompressionResult({
      ...lastResult,
      beforeTokens: aggregateBefore ?? lastResult?.beforeTokens ?? 0,
      afterTokens: lastResult?.afterTokens ?? aggregateBefore ?? 0,
      savedTokens: Math.max(0, (aggregateBefore ?? 0) - (lastResult?.afterTokens ?? aggregateBefore ?? 0)),
      beforeUtilization: initialUtilization,
      afterUtilization: currentProfile?.contextUtilization,
      targetUtilization: target,
      compressionPasses: passes,
      targetReached: false,
      unableToReachTarget: true,
      reasonCodes: [...aggregateReasonCodes, 'MAX_PASSES_REACHED'],
    });
    return { messages: currentMessages, profile: currentProfile, result };
  }
}
