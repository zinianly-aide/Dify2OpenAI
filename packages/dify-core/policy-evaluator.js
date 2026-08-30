import { validatePolicyCandidate } from './policy-candidate.js';

export const PolicyEvaluation = Object.freeze({
  ACCEPT_FOR_CANARY: 'ACCEPT_FOR_CANARY',
  NEEDS_REVIEW: 'NEEDS_REVIEW',
  REJECT: 'REJECT',
});

export const DEFAULT_POLICY_EVALUATOR_CONFIG = Object.freeze({
  maxOverflowIncreasePct: 0,
  maxFallbackIncreasePctForAccept: 5,
  maxRoutingDriftForAccept: 0.20,
  maxRoutingDriftBeforeReview: 0.50,
  maxToolRecoveryRiskForAccept: 0.04,
  maxToolRecoveryRiskBeforeReject: 0.08,
  minimumTokenSavingsPctForAccept: 5,
});

function finite(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export class PolicyEvaluator {
  constructor(config = {}) { this.config = Object.freeze({ ...DEFAULT_POLICY_EVALUATOR_CONFIG, ...config }); }

  evaluate({ candidate, replayResult } = {}) {
    const validation = validatePolicyCandidate(candidate || {});
    const reasons = [];
    if (!validation.valid) {
      return Object.freeze({
        conclusion: PolicyEvaluation.REJECT,
        reasonCodes: Object.freeze(['CANDIDATE_VALIDATION_FAILED', ...validation.errors]),
      });
    }
    if (!replayResult || replayResult.candidateId !== candidate.candidateId || replayResult.basePolicyVersion !== candidate.basePolicyVersion) {
      return Object.freeze({ conclusion: PolicyEvaluation.REJECT, reasonCodes: Object.freeze(['REPLAY_IDENTITY_MISMATCH']) });
    }

    const risk = replayResult.risk || {};
    const delta = replayResult.delta || {};
    const baseline = replayResult.baseline || {};
    const predicted = replayResult.candidate || {};
    if (finite(risk.capabilityViolationCount) > 0) reasons.push('CAPABILITY_VIOLATION');
    if (finite(risk.unsupportedDecisionCount) > 0) reasons.push('UNSUPPORTED_DECISION');
    const overflowBase = finite(baseline.predictedOverflowCount);
    const overflowCandidate = finite(predicted.predictedOverflowCount);
    const overflowIncreasePct = overflowBase === 0
      ? (overflowCandidate > 0 ? Infinity : 0)
      : ((overflowCandidate - overflowBase) / overflowBase) * 100;
    if (overflowIncreasePct > this.config.maxOverflowIncreasePct) reasons.push('CONTEXT_OVERFLOW_INCREASE');
    if (finite(risk.toolRecoveryRisk) >= this.config.maxToolRecoveryRiskBeforeReject) reasons.push('TOOL_RECOVERY_RISK_TOO_HIGH');
    if (replayResult.dataset?.basePolicyMismatchCount > 0 && replayResult.dataset?.mixedPolicyVersions !== true) reasons.push('BASE_POLICY_VERSION_MISMATCH');
    if (reasons.length) return Object.freeze({ conclusion: PolicyEvaluation.REJECT, reasonCodes: Object.freeze(reasons) });

    const tokenPct = finite(delta.tokenPct);
    const costPct = finite(delta.costPct);
    const fallbackPct = delta.fallbackPct === null ? 0 : finite(delta.fallbackPct);
    const routingDrift = finite(risk.routingDrift);
    const recoveryRisk = finite(risk.toolRecoveryRisk);
    const beneficial = tokenPct <= -this.config.minimumTokenSavingsPctForAccept || costPct < 0 || overflowCandidate < overflowBase;
    const softRisk = routingDrift > this.config.maxRoutingDriftForAccept
      || fallbackPct > this.config.maxFallbackIncreasePctForAccept
      || recoveryRisk > this.config.maxToolRecoveryRiskForAccept;

    if (beneficial && !softRisk) {
      return Object.freeze({
        conclusion: PolicyEvaluation.ACCEPT_FOR_CANARY,
        reasonCodes: Object.freeze(['PREDICTED_BENEFIT', 'HARD_GUARDRAILS_PASSED', 'SOFT_GUARDRAILS_PASSED']),
      });
    }
    if (beneficial) {
      const reviewReasons = ['PREDICTED_BENEFIT_WITH_SOFT_RISK'];
      if (routingDrift > this.config.maxRoutingDriftForAccept) reviewReasons.push('ROUTING_DRIFT_REVIEW');
      if (fallbackPct > this.config.maxFallbackIncreasePctForAccept) reviewReasons.push('FALLBACK_INCREASE_REVIEW');
      if (recoveryRisk > this.config.maxToolRecoveryRiskForAccept) reviewReasons.push('TOOL_RECOVERY_RISK_REVIEW');
      return Object.freeze({ conclusion: PolicyEvaluation.NEEDS_REVIEW, reasonCodes: Object.freeze(reviewReasons) });
    }
    return Object.freeze({ conclusion: PolicyEvaluation.NEEDS_REVIEW, reasonCodes: Object.freeze(['NO_CLEAR_PREDICTED_BENEFIT']) });
  }
}

export function createPolicyCandidateReport({ candidate, replayResult, evaluation } = {}) {
  const json = Object.freeze({
    candidate,
    replay: replayResult,
    evaluation,
  });
  const evidence = candidate?.evidence || {};
  const changes = candidate?.changes || {};
  const delta = replayResult?.delta || {};
  const risk = replayResult?.risk || {};
  const summary = [
    `Candidate ${candidate?.candidateId || 'unknown'} is based on ${candidate?.basePolicyVersion || 'unknown'}.`,
    `Why: ${candidate?.hypothesis || 'No hypothesis provided.'}`,
    `Evidence: ${Object.entries(evidence).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${String(value)}`).join(', ') || 'none'}.`,
    `Changes: ${JSON.stringify(changes)}.`,
    `Replay prediction: tokenPct=${delta.tokenPct ?? 'unknown'}, costPct=${delta.costPct ?? 'unknown'}, overflowPct=${delta.overflowPct ?? 'unknown'}, fallbackPct=${delta.fallbackPct ?? 'unknown'}.`,
    `Risk: routingDrift=${risk.routingDrift ?? 'unknown'}, toolRecoveryRisk=${risk.toolRecoveryRisk ?? 'unknown'}, capabilityViolationCount=${risk.capabilityViolationCount ?? 'unknown'}, unsupportedDecisionCount=${risk.unsupportedDecisionCount ?? 'unknown'}.`,
    `Evaluator: ${evaluation?.conclusion || 'NOT_EVALUATED'} (${(evaluation?.reasonCodes || []).join(', ') || 'no reasons'}).`,
    'Replay values are estimated/predicted proxies; future real answer quality, latency, and tool success are not claimed.',
  ].join('\n');
  return Object.freeze({ json, summary });
}
