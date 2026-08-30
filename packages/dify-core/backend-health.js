export const BackendHealthState = Object.freeze({
  HEALTHY: 'HEALTHY',
  DEGRADED: 'DEGRADED',
  UNAVAILABLE: 'UNAVAILABLE',
});

export const DEFAULT_BACKEND_HEALTH_CONFIG = Object.freeze({
  minimumSamples: 4,
  degradedFailureRate: 0.25,
  unavailableFailureRate: 0.60,
  degradedTimeoutRate: 0.20,
  unavailableConsecutiveFailures: 3,
  windowSize: 20,
});

function clampRate(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

export class BackendHealthStore {
  constructor(config = {}) {
    this.config = Object.freeze({ ...DEFAULT_BACKEND_HEALTH_CONFIG, ...config });
    this.records = new Map();
  }

  _record(backendId) {
    const key = String(backendId);
    if (!this.records.has(key)) {
      this.records.set(key, { backendId: key, samples: [], lastFailureAt: null, consecutiveFailures: 0 });
    }
    return this.records.get(key);
  }

  recordSuccess(backendId) {
    const record = this._record(backendId);
    record.samples.push({ failed: false, timeout: false });
    if (record.samples.length > this.config.windowSize) record.samples.shift();
    record.consecutiveFailures = 0;
    return this.get(backendId);
  }

  recordFailure(backendId, { timeout = false, at = Date.now() } = {}) {
    const record = this._record(backendId);
    record.samples.push({ failed: true, timeout: timeout === true });
    if (record.samples.length > this.config.windowSize) record.samples.shift();
    record.lastFailureAt = at;
    record.consecutiveFailures += 1;
    return this.get(backendId);
  }

  setSnapshot(backendId, snapshot = {}) {
    const key = String(backendId);
    const sampleCount = Number.isInteger(snapshot.sampleCount) && snapshot.sampleCount >= 0 ? snapshot.sampleCount : this.config.minimumSamples;
    const failureRate = clampRate(snapshot.recentFailureRate);
    const timeoutRate = clampRate(snapshot.timeoutRate);
    const failed = Math.round(sampleCount * failureRate);
    const timeouts = Math.min(failed, Math.round(sampleCount * timeoutRate));
    const samples = [];
    for (let i = 0; i < sampleCount; i += 1) samples.push({ failed: i < failed, timeout: i < timeouts });
    this.records.set(key, {
      backendId: key,
      samples,
      lastFailureAt: snapshot.lastFailureAt ?? null,
      consecutiveFailures: Number(snapshot.consecutiveFailures || 0),
      forcedState: Object.values(BackendHealthState).includes(snapshot.state) ? snapshot.state : undefined,
    });
    return this.get(key);
  }

  get(backendId) {
    const record = this._record(backendId);
    const count = record.samples.length;
    const failures = record.samples.filter((x) => x.failed).length;
    const timeouts = record.samples.filter((x) => x.timeout).length;
    const recentFailureRate = count ? failures / count : 0;
    const timeoutRate = count ? timeouts / count : 0;
    let state = record.forcedState;
    if (!state) {
      if (record.consecutiveFailures >= this.config.unavailableConsecutiveFailures || (count >= this.config.minimumSamples && recentFailureRate >= this.config.unavailableFailureRate)) {
        state = BackendHealthState.UNAVAILABLE;
      } else if (count >= this.config.minimumSamples && (recentFailureRate >= this.config.degradedFailureRate || timeoutRate >= this.config.degradedTimeoutRate)) {
        state = BackendHealthState.DEGRADED;
      } else {
        state = BackendHealthState.HEALTHY;
      }
    }
    return Object.freeze({
      backendId: String(backendId),
      state,
      recentFailureRate,
      timeoutRate,
      lastFailureAt: record.lastFailureAt,
      consecutiveFailures: record.consecutiveFailures,
    });
  }

  snapshot() {
    return Object.freeze([...this.records.keys()].sort().map((id) => this.get(id)));
  }
}
