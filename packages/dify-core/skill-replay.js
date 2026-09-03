import { canonicalJson, sha256 } from './canonical.js';
import { ReplayRunner, ReplayVariant, normalizeReplayCase } from './replay-runner.js';

const OBSERVED_REPLAYS = new WeakSet();

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) freeze(child);
  return value;
}

function normalizeMetrics(metrics = {}) {
  const numberOrNull = (v) => Number.isFinite(Number(v)) ? Number(v) : null;
  const out = {
    taskSuccess: numberOrNull(metrics.taskSuccess),
    toolSuccess: numberOrNull(metrics.toolSuccess),
    toolRetry: numberOrNull(metrics.toolRetry),
    contextUsage: numberOrNull(metrics.contextUsage),
    tokenUsage: numberOrNull(metrics.tokenUsage),
    latency: numberOrNull(metrics.latency),
    cost: numberOrNull(metrics.cost),
    errorRate: numberOrNull(metrics.errorRate),
  };
  if (Number.isFinite(Number(metrics.qualityScore))) out.qualityScore = Number(metrics.qualityScore);
  return freeze(out);
}

async function executeVariant(runner, replayCase, variant, context) {
  const observed = await runner.execute(Object.freeze({ replayCase, variant, ...context }));
  if (!observed || typeof observed !== 'object') throw new Error('REPLAY_RUNNER_METRICS_INVALID');
  const metrics = normalizeMetrics(observed);
  return freeze({
    variant,
    metrics,
    evidenceId: runner.evidenceId({ replayCase, variant, observedMetrics: metrics }),
  });
}

export class SkillReplay {
  async run({ skillId, scope, cases = [], runner, baselineSkill = null, candidateSkill = null } = {}) {
    if (!(runner instanceof ReplayRunner)) throw new Error('REPLAY_RUNNER_REQUIRED');
    const observedCases = [];
    for (const input of cases) {
      const replayCase = normalizeReplayCase(input);
      const shared = { skillId, scope, baselineSkill, candidateSkill };
      const noSkill = await executeVariant(runner, replayCase, ReplayVariant.NO_SKILL, shared);
      const baseline = await executeVariant(runner, replayCase, ReplayVariant.BASELINE_SKILL, shared);
      const candidate = await executeVariant(runner, replayCase, ReplayVariant.CANDIDATE_SKILL, shared);
      observedCases.push(freeze({
        ...replayCase,
        noSkill: noSkill.metrics,
        baselineSkill: baseline.metrics,
        candidateSkill: candidate.metrics,
        evidence: freeze({
          noSkill: noSkill.evidenceId,
          baselineSkill: baseline.evidenceId,
          candidateSkill: candidate.evidenceId,
        }),
      }));
    }
    observedCases.sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
    const body = { skillId, scope, runnerId: runner.runnerId, cases: observedCases };
    const contentHash = sha256(canonicalJson(body));
    const result = freeze({ replayId: `skill-replay-${contentHash.slice(0, 24)}`, contentHash, evidenceSource: 'ReplayRunner', ...body });
    OBSERVED_REPLAYS.add(result);
    return result;
  }
}

export function assertObservedSkillReplayResult(replay) {
  if (!replay || !OBSERVED_REPLAYS.has(replay) || replay.evidenceSource !== 'ReplayRunner') {
    throw new Error('SKILL_REPLAY_UNTRUSTED_EVIDENCE');
  }
  return true;
}
