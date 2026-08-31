import { canonicalJson, sha256 } from './canonical.js';

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
  return out;
}

export class SkillReplay {
  run({ skillId, scope, cases = [] } = {}) {
    const normalizedCases = cases.map((item) => ({
      taskId: String(item.taskId),
      client: String(item.client),
      model: String(item.model),
      backend: String(item.backend),
      toolAvailability: [...new Set(item.toolAvailability || [])].sort(),
      contextBudget: Number(item.contextBudget),
      evaluationCriteria: [...new Set(item.evaluationCriteria || [])].sort(),
      noSkill: normalizeMetrics(item.noSkill),
      baselineSkill: normalizeMetrics(item.baselineSkill),
      candidateSkill: normalizeMetrics(item.candidateSkill),
    })).sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
    const body = { skillId, scope, cases: normalizedCases };
    const contentHash = sha256(canonicalJson(body));
    return freeze({ replayId: `skill-replay-${contentHash.slice(0, 24)}`, contentHash, ...body });
  }
}
