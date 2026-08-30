import { canonicalJson, sha256 } from './canonical.js';

export const POLICY_CANDIDATE_SCHEMA_VERSION = 'policy-candidate-v1';

export const DEFAULT_POLICY_LIMITS = Object.freeze({
  compression: Object.freeze({
    toolPruneThreshold: [0.05, 0.90],
    lightThreshold: [0.10, 0.95],
    heavyThreshold: [0.20, 0.98],
    forceThreshold: [0.30, 1.00],
    targetUtilization: [0.40, 0.90],
  }),
  checkpoint: Object.freeze({
    backendContextUtilizationThreshold: [0.50, 0.99],
    amplificationThreshold: [1.00, 10.00],
  }),
  backendHealth: Object.freeze({
    minimumSamples: [1, 1000],
    unavailableConsecutiveFailures: [1, 20],
    degradedFailureRate: [0.01, 0.90],
    unavailableFailureRate: [0.05, 1.00],
  }),
  tool: Object.freeze({
    pruningConfidenceThreshold: [0.10, 1.00],
    recoveryLimit: [0, 3],
  }),
  backendPriority: Object.freeze({ value: [0, 10000] }),
});

function inRange(value, range) {
  const n = Number(value);
  return Number.isFinite(n) && n >= range[0] && n <= range[1];
}

function plainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype);
}

function safeString(value, max = 2000) {
  if (typeof value !== 'string') return false;
  if (value.length > max) return false;
  return !/(<script|javascript:|\beval\s*\(|\bfunction\s*\(|=>|child_process|exec\s*\(|spawn\s*\()/i.test(value);
}

export function validatePolicyChanges(changes, limits = DEFAULT_POLICY_LIMITS) {
  const errors = [];
  if (!plainObject(changes)) return Object.freeze({ valid: false, errors: Object.freeze(['CHANGES_MUST_BE_OBJECT']) });
  const allowedSections = new Set(['compression', 'checkpoint', 'backendPriority', 'backendHealth', 'tool']);
  for (const section of Object.keys(changes).sort()) {
    if (!allowedSections.has(section)) {
      errors.push(`POLICY_FIELD_NOT_ALLOWED:${section}`);
      continue;
    }
    if (!plainObject(changes[section])) {
      errors.push(`POLICY_SECTION_INVALID:${section}`);
      continue;
    }
    if (section === 'backendPriority') {
      for (const [backendId, value] of Object.entries(changes.backendPriority).sort(([a], [b]) => a.localeCompare(b))) {
        if (!backendId || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(backendId)) errors.push(`BACKEND_PRIORITY_KEY_INVALID:${backendId}`);
        if (!inRange(value, limits.backendPriority.value)) errors.push(`POLICY_VALUE_OUT_OF_RANGE:backendPriority.${backendId}`);
      }
      continue;
    }
    const allowedFields = limits[section];
    for (const field of Object.keys(changes[section]).sort()) {
      if (!(field in allowedFields)) errors.push(`POLICY_FIELD_NOT_ALLOWED:${section}.${field}`);
      else if (!inRange(changes[section][field], allowedFields[field])) errors.push(`POLICY_VALUE_OUT_OF_RANGE:${section}.${field}`);
    }
  }

  const compression = changes.compression || {};
  const thresholdFields = ['toolPruneThreshold', 'lightThreshold', 'heavyThreshold', 'forceThreshold'];
  if (thresholdFields.every((field) => compression[field] !== undefined)) {
    const [toolPrune, light, heavy, force] = thresholdFields.map((field) => Number(compression[field]));
    if (!(toolPrune < light && light < heavy && heavy < force)) errors.push('COMPRESSION_THRESHOLDS_ORDER_INVALID');
  }
  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors) });
}

export function validatePolicyCandidate(candidate, limits = DEFAULT_POLICY_LIMITS) {
  const errors = [];
  if (!plainObject(candidate)) return Object.freeze({ valid: false, errors: Object.freeze(['CANDIDATE_MUST_BE_OBJECT']) });
  if (!safeString(String(candidate.candidateId || ''), 256) || !candidate.candidateId) errors.push('CANDIDATE_ID_INVALID');
  if (!safeString(String(candidate.basePolicyVersion || ''), 256) || !candidate.basePolicyVersion) errors.push('BASE_POLICY_VERSION_INVALID');
  if (!plainObject(candidate.evidence)) errors.push('EVIDENCE_INVALID');
  if (!safeString(String(candidate.hypothesis || ''))) errors.push('HYPOTHESIS_INVALID');
  if (!plainObject(candidate.expectedImpact)) errors.push('EXPECTED_IMPACT_INVALID');
  if (!['low', 'medium', 'high'].includes(candidate.confidence)) errors.push('CONFIDENCE_INVALID');
  const changes = validatePolicyChanges(candidate.changes, limits);
  errors.push(...changes.errors);
  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors) });
}

function createCandidate({ basePolicyVersion, changes, evidence, hypothesis, expectedImpact, confidence, createdAt }) {
  const identity = { basePolicyVersion, changes, evidence, hypothesis, expectedImpact, confidence };
  const candidateId = `pc-${sha256(canonicalJson(identity)).slice(0, 20)}`;
  return Object.freeze({
    candidateId,
    basePolicyVersion,
    changes: Object.freeze(changes),
    evidence: Object.freeze(evidence),
    hypothesis,
    expectedImpact: Object.freeze(expectedImpact),
    confidence,
    createdAt,
    schemaVersion: POLICY_CANDIDATE_SCHEMA_VERSION,
  });
}

export const DEFAULT_CANDIDATE_GENERATOR_CONFIG = Object.freeze({
  minimumEvidence: 20,
  highContextRate: 0.50,
  highBackendP95Ms: 2500,
  highToolSchemaTokensPerRequest: 1200,
  lowToolRecoveryRate: 0.02,
  highToolRecoveryRate: 0.06,
});

export class DeterministicPolicyCandidateGenerator {
  constructor(config = {}) { this.config = Object.freeze({ ...DEFAULT_CANDIDATE_GENERATOR_CONFIG, ...config }); }

  generate({ analysis, snapshot, basePolicyVersion, baselinePolicy = {}, compatibleBackendIds = [] } = {}) {
    const count = Number(analysis?.requestCount || 0);
    if (!basePolicyVersion || count < this.config.minimumEvidence) return Object.freeze({ status: 'NO_CANDIDATE', reasonCodes: Object.freeze(['INSUFFICIENT_EVIDENCE']), candidates: Object.freeze([]) });
    const createdAt = snapshot?.endTime || '1970-01-01T00:00:00.000Z';
    const candidates = [];
    const overall = analysis.overall || {};

    if (Number(overall.highContextRate || 0) >= this.config.highContextRate) {
      const current = Number(baselinePolicy?.checkpoint?.backendContextUtilizationThreshold ?? 0.90);
      const next = Math.max(0.50, Math.min(current - 0.05, 0.85));
      if (next < current) candidates.push(createCandidate({
        basePolicyVersion,
        changes: { checkpoint: { backendContextUtilizationThreshold: next } },
        evidence: { requestCount: count, highContextRate: overall.highContextRate, checkpointFrequency: overall.checkpointFrequency },
        hypothesis: 'Historical context utilization is persistently high; checkpointing earlier may reduce predicted overflow pressure.',
        expectedImpact: { overflow: 'decrease_predicted', checkpoint: 'increase_predicted' },
        confidence: count >= this.config.minimumEvidence * 3 ? 'high' : 'medium', createdAt,
      }));
    }

    for (const group of analysis.groups || []) {
      const backendId = group.dimensions?.backendId;
      const p95 = Number(group.metrics?.latencyMs?.p95);
      if (backendId && group.metrics?.requestCount >= this.config.minimumEvidence && Number.isFinite(p95) && p95 >= this.config.highBackendP95Ms && compatibleBackendIds.some((id) => id !== backendId)) {
        const current = Number(baselinePolicy?.backendPriority?.[backendId] ?? 100);
        candidates.push(createCandidate({
          basePolicyVersion,
          changes: { backendPriority: { [backendId]: Math.min(10000, current + 20) } },
          evidence: { backendId, requestCount: group.metrics.requestCount, observedLatencyP95Ms: p95, compatibleBackendCount: compatibleBackendIds.length },
          hypothesis: 'Observed p95 latency is high and compatible alternatives exist; lowering this backend routing preference may reduce latency exposure.',
          expectedImpact: { routing: 'shift_predicted', latency: 'not_replayed_real_latency' },
          confidence: 'medium', createdAt,
        }));
      }
    }

    const avgSchema = count ? Number(overall.toolSchemaTokens?.before || 0) / count : 0;
    const recoveryRate = Number(overall.toolRecoveryRate || 0);
    const currentPrune = Number(baselinePolicy?.tool?.pruningConfidenceThreshold ?? 0.65);
    if (avgSchema >= this.config.highToolSchemaTokensPerRequest && recoveryRate <= this.config.lowToolRecoveryRate) {
      candidates.push(createCandidate({
        basePolicyVersion,
        changes: { tool: { pruningConfidenceThreshold: Math.max(0.10, currentPrune - 0.05) } },
        evidence: { requestCount: count, avgToolSchemaTokensBefore: avgSchema, observedToolRecoveryRate: recoveryRate },
        hypothesis: 'Tool schema cost is high while observed recovery is low; slightly stronger deterministic pruning may reduce schema tokens.',
        expectedImpact: { toolSchemaTokens: 'decrease_predicted', toolRecoveryRisk: 'increase_proxy_possible' },
        confidence: 'medium', createdAt,
      }));
    } else if (recoveryRate >= this.config.highToolRecoveryRate) {
      candidates.push(createCandidate({
        basePolicyVersion,
        changes: { tool: { pruningConfidenceThreshold: Math.min(1, currentPrune + 0.08) } },
        evidence: { requestCount: count, observedToolRecoveryRate: recoveryRate },
        hypothesis: 'Observed full-tool recovery is elevated; more conservative pruning may reduce recovery risk.',
        expectedImpact: { toolSchemaTokens: 'increase_predicted', toolRecoveryRisk: 'decrease_predicted' },
        confidence: 'medium', createdAt,
      }));
    }

    const unique = [...new Map(candidates.map((candidate) => [candidate.candidateId, candidate])).values()].sort((a, b) => a.candidateId.localeCompare(b.candidateId));
    return Object.freeze({
      status: unique.length ? 'CANDIDATES' : 'NO_CANDIDATE',
      reasonCodes: Object.freeze(unique.length ? ['DETERMINISTIC_EVIDENCE_RULE_MATCH'] : ['NO_RULE_WITH_SUFFICIENT_EVIDENCE']),
      candidates: Object.freeze(unique),
    });
  }
}
