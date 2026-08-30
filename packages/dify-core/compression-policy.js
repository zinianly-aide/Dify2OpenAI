export const DEFAULT_COMPRESSION_CONFIG = Object.freeze({
  toolPruneThreshold: 0.55,
  lightThreshold: 0.70,
  heavyThreshold: 0.82,
  forceThreshold: 0.92,
  preservedRecentTurns: 3,
  lightSummaryMaxChars: 2400,
  heavySummaryMaxChars: 1200,
});

function finiteNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function positiveInteger(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
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
  };
}

export class CompressionPolicy {
  constructor(config = {}) {
    this.config = Object.freeze({ ...DEFAULT_COMPRESSION_CONFIG, ...config });
    const { toolPruneThreshold, lightThreshold, heavyThreshold, forceThreshold } = this.config;
    if (!(toolPruneThreshold >= 0 && toolPruneThreshold < lightThreshold && lightThreshold < heavyThreshold && heavyThreshold < forceThreshold && forceThreshold <= 1)) {
      throw new Error('compression thresholds must satisfy 0 <= toolPrune < light < heavy < force <= 1');
    }
  }

  decide(profile) {
    const utilization = profile?.contextUtilization;
    if (utilization === undefined || utilization === null || !Number.isFinite(Number(utilization))) {
      return Object.freeze({ mode: 'none', forced: false, reasonCodes: ['compression_context_utilization_unknown'] });
    }
    const u = Number(utilization);
    let mode = 'none';
    let forced = false;
    if (u >= this.config.forceThreshold) {
      mode = 'heavy';
      forced = true;
    } else if (u >= this.config.heavyThreshold) mode = 'heavy';
    else if (u >= this.config.lightThreshold) mode = 'light';
    else if (u >= this.config.toolPruneThreshold) mode = 'tool_prune';
    return Object.freeze({
      mode,
      forced,
      reasonCodes: [
        `compression_mode=${mode}`,
        `context_utilization_band=${u.toFixed(2)}`,
        ...(forced ? ['compression_forced_threshold_reached'] : []),
      ],
    });
  }
}
