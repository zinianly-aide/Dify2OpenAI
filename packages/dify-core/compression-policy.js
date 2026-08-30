export const DEFAULT_COMPRESSION_CONFIG = Object.freeze({
  toolPruneThreshold: 0.55,
  lightThreshold: 0.70,
  heavyThreshold: 0.82,
  forceThreshold: 0.92,
  preservedRecentTurns: 3,
  lightSummaryMaxChars: 2400,
  heavySummaryMaxChars: 1200,
  rules: [],
});

function finiteNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function positiveInteger(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

function validateThresholds(config, label = 'compression') {
  const { toolPruneThreshold, lightThreshold, heavyThreshold, forceThreshold } = config;
  if (!(toolPruneThreshold >= 0 && toolPruneThreshold < lightThreshold && lightThreshold < heavyThreshold && heavyThreshold < forceThreshold && forceThreshold <= 1)) {
    throw new Error(`${label} thresholds must satisfy 0 <= toolPrune < light < heavy < force <= 1`);
  }
}

function matches(rule, profile) {
  const match = rule?.match || {};
  if (match.clientType !== undefined && String(match.clientType) !== String(profile?.clientType || '')) return false;
  if (match.backendId !== undefined && String(match.backendId) !== String(profile?.backendId || '')) return false;
  if (match.model !== undefined && String(match.model) !== String(profile?.model || '')) return false;
  return true;
}

function safeCode(value, fallback = 'unknown') {
  const text = String(value ?? fallback).replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 96);
  return text || fallback;
}

export function compressionConfigFromEnv(env = process.env) {
  return {
    toolPruneThreshold: finiteNumber(env.GATEWAY_COMPRESSION_TOOL_PRUNE_THRESHOLD, DEFAULT_COMPRESSION_CONFIG.toolPruneThreshold),
    lightThreshold: finiteNumber(env.GATEWAY_COMPRESSION_LIGHT_THRESHOLD, DEFAULT_COMPRESSION_CONFIG.lightThreshold),
    heavyThreshold: finiteNumber(env.GATEWAY_COMPRESSION_HEAVY_THRESHOLD, DEFAULT_COMPRESSION_CONFIG.heavyThreshold),
    forceThreshold: finiteNumber(env.GATEWAY_COMPRESSION_FORCE_THRESHOLD, DEFAULT_COMPRESSION_CONFIG.forceThreshold),
    preservedRecentTurns: positiveInteger(env.GATEWAY_COMPRESSION_RECENT_TURNS, DEFAULT_COMPRESSION_CONFIG.preservedRecentTurns),
    lightSummaryMaxChars: positiveInteger(env.GATEWAY_COMPRESSION_LIGHT_SUMMARY_MAX_CHARS, DEFAULT_COMPRESSION_CONFIG.lightSummaryMaxChars),
    heavySummaryMaxChars: positiveInteger(env.GATEWAY_COMPRESSION_HEAVY_SUMMARY_MAX_CHARS, DEFAULT_COMPRESSION_CONFIG.heavySummaryMaxChars),
    rules: [],
  };
}

export class CompressionPolicy {
  constructor(config = {}) {
    const rules = Array.isArray(config.rules) ? config.rules.map((rule, index) => {
      const merged = { ...DEFAULT_COMPRESSION_CONFIG, ...config, ...(rule?.config || rule?.thresholds || {}), rules: [] };
      validateThresholds(merged, `compression rule ${index}`);
      return Object.freeze({
        id: safeCode(rule?.id, `rule_${index}`),
        match: Object.freeze({ ...(rule?.match || {}) }),
        config: Object.freeze(merged),
      });
    }) : [];
    this.config = Object.freeze({ ...DEFAULT_COMPRESSION_CONFIG, ...config, rules: Object.freeze(rules) });
    validateThresholds(this.config);
  }

  configFor(profile) {
    const rule = this.config.rules.find((candidate) => matches(candidate, profile));
    return { config: rule?.config || this.config, ruleId: rule?.id };
  }

  decide(profile) {
    const { config, ruleId } = this.configFor(profile);
    const utilization = profile?.contextUtilization;
    const evidence = [
      `compression_profile_client=${safeCode(profile?.clientType)}`,
      `compression_profile_backend=${safeCode(profile?.backendId)}`,
      `compression_profile_model=${safeCode(profile?.model)}`,
      `compression_profile_messages=${Math.max(0, Number(profile?.messageCount) || 0)}`,
      `compression_profile_tool_schema_tokens=${Math.max(0, Number(profile?.toolSchemaTokens ?? profile?.toolSchemaEstimatedTokens) || 0)}`,
      `compression_profile_estimated_tokens=${Math.max(0, Number(profile?.estimatedPromptTokens) || 0)}`,
      `compression_profile_context_window=${Math.max(0, Number(profile?.contextWindow) || 0)}`,
      ...(ruleId ? [`compression_rule=${ruleId}`] : ['compression_rule=default']),
    ];
    if (utilization === undefined || utilization === null || !Number.isFinite(Number(utilization))) {
      return Object.freeze({
        mode: 'none',
        forced: false,
        config,
        reasonCodes: ['compression_context_utilization_unknown', ...evidence],
      });
    }
    const u = Number(utilization);
    let mode = 'none';
    let forced = false;
    if (u >= config.forceThreshold) {
      mode = 'heavy';
      forced = true;
    } else if (u >= config.heavyThreshold) mode = 'heavy';
    else if (u >= config.lightThreshold) mode = 'light';
    else if (u >= config.toolPruneThreshold) mode = 'tool_prune';
    return Object.freeze({
      mode,
      forced,
      config,
      reasonCodes: [
        `compression_mode=${mode}`,
        `context_utilization_band=${u.toFixed(2)}`,
        ...evidence,
        ...(forced ? ['compression_forced_threshold_reached'] : []),
      ],
    });
  }
}
