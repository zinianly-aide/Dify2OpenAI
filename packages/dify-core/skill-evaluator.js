import { SkillScope } from './skill-candidate.js';
import { SkillStatus } from './skill-registry.js';
import { assertObservedSkillReplayResult } from './skill-replay.js';

function delta(candidate, baseline) {
  if (!Number.isFinite(candidate) || !Number.isFinite(baseline)) return null;
  return candidate - baseline;
}
function avg(values) {
  const valid = values.filter((v) => Number.isFinite(v));
  return valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null;
}

export class SkillEvaluator {
  constructor({ successRegressionFail = -0.05, severeTransferRegression = -0.15, transferReviewRegression = -0.05 } = {}) {
    this.successRegressionFail = successRegressionFail;
    this.severeTransferRegression = severeTransferRegression;
    this.transferReviewRegression = transferReviewRegression;
  }

  evaluate(replay) {
    assertObservedSkillReplayResult(replay);
    const environment = replay.cases.map((item) => ({
      taskId: item.taskId,
      client: item.client,
      model: item.model,
      backend: item.backend,
      taskSuccessDelta: delta(item.candidateSkill.taskSuccess, item.noSkill.taskSuccess),
      toolSuccessDelta: delta(item.candidateSkill.toolSuccess, item.noSkill.toolSuccess),
      toolRetryDelta: delta(item.candidateSkill.toolRetry, item.noSkill.toolRetry),
      tokenDelta: delta(item.candidateSkill.tokenUsage, item.noSkill.tokenUsage),
      latencyDelta: delta(item.candidateSkill.latency, item.noSkill.latency),
      costDelta: delta(item.candidateSkill.cost, item.noSkill.cost),
      errorRateDelta: delta(item.candidateSkill.errorRate, item.noSkill.errorRate),
      qualityDelta: delta(item.candidateSkill.qualityScore, item.noSkill.qualityScore),
    }));

    const successDeltas = environment.map((e) => e.taskSuccessDelta).filter(Number.isFinite);
    const meanSuccessDelta = avg(successDeltas);
    const minSuccessDelta = successDeltas.length ? Math.min(...successDeltas) : null;
    const maxSuccessDelta = successDeltas.length ? Math.max(...successDeltas) : null;
    const hasPositive = successDeltas.some((v) => v >= 0.05);
    const hasReviewRegression = successDeltas.some((v) => v <= this.transferReviewRegression);
    const hasSevereRegression = successDeltas.some((v) => v <= this.severeTransferRegression);
    const universalRegression = successDeltas.length > 0 && successDeltas.every((v) => v <= this.successRegressionFail);
    const qualityRegression = environment.some((e) => Number.isFinite(e.qualityDelta) && e.qualityDelta <= -0.05);

    let status = SkillStatus.REPLAY_PASSED;
    let reasonCode = 'SKILL_REPLAY_IMPROVED_OR_NON_REGRESSIVE';
    let suggestedScope = replay.scope;

    if (qualityRegression || universalRegression || hasSevereRegression) {
      status = SkillStatus.REPLAY_FAILED;
      reasonCode = qualityRegression ? 'QUALITY_REGRESSION' : hasSevereRegression ? 'NEGATIVE_TRANSFER_SEVERE' : 'TASK_SUCCESS_REGRESSION';
    } else if (replay.scope === SkillScope.GENERAL && hasPositive && hasReviewRegression) {
      status = SkillStatus.NEEDS_REVIEW;
      reasonCode = 'NEGATIVE_TRANSFER_SCOPE_REVIEW';
      const models = new Set(environment.map((e) => e.model));
      const clients = new Set(environment.map((e) => e.client));
      suggestedScope = models.size > 1 ? SkillScope.MODEL_SPECIFIC : clients.size > 1 ? SkillScope.CLIENT_SPECIFIC : replay.scope;
    } else if (meanSuccessDelta !== null && meanSuccessDelta < 0) {
      status = SkillStatus.REPLAY_FAILED;
      reasonCode = 'TASK_SUCCESS_REGRESSION';
    }

    return Object.freeze({
      replayId: replay.replayId,
      status,
      reasonCode,
      suggestedScope,
      transferScore: meanSuccessDelta,
      minSuccessDelta,
      maxSuccessDelta,
      environment: Object.freeze(environment.map(Object.freeze)),
    });
  }
}
