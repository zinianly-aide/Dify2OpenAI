import { canonicalJson, sha256 } from './canonical.js';

export const ReplayVariant = Object.freeze({
  NO_SKILL: 'NO_SKILL',
  BASELINE_SKILL: 'BASELINE_SKILL',
  CANDIDATE_SKILL: 'CANDIDATE_SKILL',
});

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) freeze(child);
  return value;
}

export function normalizeReplayCase(input = {}) {
  for (const forbidden of ['noSkill', 'baselineSkill', 'candidateSkill']) {
    if (forbidden in input) throw new Error('REPLAY_CASE_PRECOMPUTED_METRICS_FORBIDDEN');
  }
  const replayCase = {
    taskId: String(input.taskId || ''),
    client: String(input.client || ''),
    model: String(input.model || ''),
    backend: String(input.backend || ''),
    toolAvailability: [...new Set(input.toolAvailability || [])].map(String).sort(),
    contextBudget: Number(input.contextBudget),
    evaluationCriteria: [...new Set(input.evaluationCriteria || [])].map(String).sort(),
    taskInputHash: input.taskInputHash ? String(input.taskInputHash) : null,
  };
  if (!replayCase.taskId || !replayCase.client || !replayCase.model || !replayCase.backend) {
    throw new Error('REPLAY_CASE_ENVIRONMENT_INVALID');
  }
  if (!Number.isFinite(replayCase.contextBudget) || replayCase.contextBudget <= 0) {
    throw new Error('REPLAY_CASE_CONTEXT_BUDGET_INVALID');
  }
  return freeze(replayCase);
}

export class ReplayRunner {
  constructor({ runnerId = 'replay-runner-v1' } = {}) {
    this.runnerId = String(runnerId);
  }

  async execute() {
    throw new Error('REPLAY_RUNNER_EXECUTE_NOT_IMPLEMENTED');
  }

  evidenceId({ replayCase, variant, observedMetrics }) {
    const body = { runnerId: this.runnerId, replayCase, variant, observedMetrics };
    return `replay-evidence-${sha256(canonicalJson(body)).slice(0, 24)}`;
  }
}
