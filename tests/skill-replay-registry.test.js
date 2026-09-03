import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PatternImpactTracker,
  PatternMiner,
  ReplayRunner,
  ReplayVariant,
  SkillEvaluator,
  SkillRegistry,
  SkillReplay,
  SkillScope,
  SkillStatus,
  WikiMaintainer,
  createSkillCandidate,
  ExperienceCompiler,
} from '../packages/dify-core/index.js';

function candidate(scope = SkillScope.GENERAL) {
  return createSkillCandidate({
    family: 'context-management',
    scope,
    instructions: '1. checkpoint.\n2. rotate only after pending tools complete.',
    sourcePatternIds: ['pattern-a'],
    purpose: { sourcePatternIds: ['pattern-a'], scope },
    evidenceSummary: { patternCount: 1, observationCount: 8 },
    confidence: 0.9,
  });
}

function replayCase(overrides = {}) {
  return {
    taskId: 'task-a',
    client: 'dsh',
    model: 'model-a',
    backend: 'backend-a',
    toolAvailability: ['read', 'write'],
    contextBudget: 32000,
    evaluationCriteria: ['task-success', 'tool-success'],
    ...overrides,
  };
}

const DEFAULT_METRICS = Object.freeze({
  [ReplayVariant.NO_SKILL]: { taskSuccess: 0.70, toolSuccess: 0.80, toolRetry: 0.20, contextUsage: 0.80, tokenUsage: 1000, latency: 1000, cost: 0.02, errorRate: 0.10 },
  [ReplayVariant.BASELINE_SKILL]: { taskSuccess: 0.76, toolSuccess: 0.84, toolRetry: 0.16, contextUsage: 0.76, tokenUsage: 950, latency: 980, cost: 0.019, errorRate: 0.08 },
  [ReplayVariant.CANDIDATE_SKILL]: { taskSuccess: 0.84, toolSuccess: 0.90, toolRetry: 0.10, contextUsage: 0.70, tokenUsage: 920, latency: 970, cost: 0.018, errorRate: 0.05 },
});

class DeterministicReplayRunner extends ReplayRunner {
  constructor({ metricsByTask = {}, defaults = DEFAULT_METRICS } = {}) {
    super({ runnerId: 'deterministic-test-runner-v1' });
    this.metricsByTask = metricsByTask;
    this.defaults = defaults;
    this.calls = [];
  }
  async execute({ replayCase: item, variant }) {
    this.calls.push({ taskId: item.taskId, client: item.client, model: item.model, backend: item.backend, variant });
    return this.metricsByTask[item.taskId]?.[variant] || this.defaults[variant];
  }
}

async function runReplay({ skill = candidate(), cases = [replayCase()], runner = new DeterministicReplayRunner() } = {}) {
  return new SkillReplay().run({ skillId: skill.skillId, scope: skill.scope, cases, runner, candidateSkill: skill });
}

test('ReplayRunner produces all three observed variants in the same environment', async () => {
  const runner = new DeterministicReplayRunner();
  const replay = await runReplay({ runner });
  assert.deepEqual(runner.calls.map((call) => call.variant), [ReplayVariant.NO_SKILL, ReplayVariant.BASELINE_SKILL, ReplayVariant.CANDIDATE_SKILL]);
  assert.equal(new Set(runner.calls.map((call) => `${call.taskId}|${call.client}|${call.model}|${call.backend}`)).size, 1);
  assert.equal(replay.evidenceSource, 'ReplayRunner');
  assert.ok(replay.cases[0].evidence.candidateSkill.startsWith('replay-evidence-'));
});

test('caller-supplied replay performance is rejected before execution', async () => {
  const item = replayCase({ candidateSkill: { taskSuccess: 1 } });
  await assert.rejects(() => runReplay({ cases: [item] }), /REPLAY_CASE_PRECOMPUTED_METRICS_FORBIDDEN/);
});

test('SkillEvaluator rejects forged arbitrary replay evidence', () => {
  const fake = { replayId: 'fake', scope: SkillScope.GENERAL, evidenceSource: 'ReplayRunner', cases: [] };
  assert.throws(() => new SkillEvaluator().evaluate(fake), /SKILL_REPLAY_UNTRUSTED_EVIDENCE/);
});

test('replay is deterministic where runner observations are identical', async () => {
  const skill = candidate();
  const a = await runReplay({ skill, runner: new DeterministicReplayRunner() });
  const b = await runReplay({ skill, runner: new DeterministicReplayRunner() });
  assert.equal(a.replayId, b.replayId);
  assert.equal(a.contentHash, b.contentHash);
});

test('Case A: observed candidate improvement reaches REPLAY_PASSED', async () => {
  const result = new SkillEvaluator().evaluate(await runReplay());
  assert.equal(result.status, SkillStatus.REPLAY_PASSED);
  assert.ok(result.transferScore > 0);
});

test('quality regression fails only when quality is observed by runner', async () => {
  const metricsByTask = {
    'task-a': {
      [ReplayVariant.NO_SKILL]: { ...DEFAULT_METRICS.NO_SKILL, qualityScore: 0.90 },
      [ReplayVariant.BASELINE_SKILL]: { ...DEFAULT_METRICS.BASELINE_SKILL, qualityScore: 0.89 },
      [ReplayVariant.CANDIDATE_SKILL]: { ...DEFAULT_METRICS.CANDIDATE_SKILL, qualityScore: 0.80 },
    },
  };
  const observed = await runReplay({ runner: new DeterministicReplayRunner({ metricsByTask }) });
  assert.equal(new SkillEvaluator().evaluate(observed).reasonCode, 'QUALITY_REGRESSION');
  const unobserved = await runReplay();
  assert.equal('qualityScore' in unobserved.cases[0].candidateSkill, false);
});

test('Case B: cross-model negative transfer becomes NEEDS_REVIEW with scope downgrade', async () => {
  const skill = candidate(SkillScope.GENERAL);
  const metricsByTask = {
    a: {
      [ReplayVariant.NO_SKILL]: { ...DEFAULT_METRICS.NO_SKILL, taskSuccess: 0.70 },
      [ReplayVariant.BASELINE_SKILL]: DEFAULT_METRICS.BASELINE_SKILL,
      [ReplayVariant.CANDIDATE_SKILL]: { ...DEFAULT_METRICS.CANDIDATE_SKILL, taskSuccess: 0.85 },
    },
    b: {
      [ReplayVariant.NO_SKILL]: { ...DEFAULT_METRICS.NO_SKILL, taskSuccess: 0.80 },
      [ReplayVariant.BASELINE_SKILL]: DEFAULT_METRICS.BASELINE_SKILL,
      [ReplayVariant.CANDIDATE_SKILL]: { ...DEFAULT_METRICS.CANDIDATE_SKILL, taskSuccess: 0.68 },
    },
  };
  const replay = await runReplay({ skill, cases: [replayCase({ taskId: 'a', model: 'model-a' }), replayCase({ taskId: 'b', model: 'model-b' })], runner: new DeterministicReplayRunner({ metricsByTask }) });
  const result = new SkillEvaluator().evaluate(replay);
  assert.equal(result.status, SkillStatus.NEEDS_REVIEW);
  assert.equal(result.suggestedScope, SkillScope.MODEL_SPECIFIC);
});

test('Case C: token reduction does not hide observed task success regression', async () => {
  const metricsByTask = {
    'task-a': {
      [ReplayVariant.NO_SKILL]: { ...DEFAULT_METRICS.NO_SKILL, taskSuccess: 0.80, tokenUsage: 1000 },
      [ReplayVariant.BASELINE_SKILL]: DEFAULT_METRICS.BASELINE_SKILL,
      [ReplayVariant.CANDIDATE_SKILL]: { ...DEFAULT_METRICS.CANDIDATE_SKILL, taskSuccess: 0.72, tokenUsage: 800 },
    },
  };
  const result = new SkillEvaluator().evaluate(await runReplay({ runner: new DeterministicReplayRunner({ metricsByTask }) }));
  assert.equal(result.status, SkillStatus.REPLAY_FAILED);
  assert.equal(result.reasonCode, 'TASK_SUCCESS_REGRESSION');
  assert.equal(result.environment[0].tokenDelta, -200);
});

test('SkillRegistry enforces governed forward-only lifecycle', () => {
  const skill = candidate();
  for (const status of [SkillStatus.ACTIVE, SkillStatus.ROLLED_BACK, SkillStatus.DEPRECATED]) {
    assert.throws(() => new SkillRegistry().register(skill, { status }), /SKILL_REGISTER_STATUS_FORBIDDEN/);
  }
  const registry = new SkillRegistry();
  registry.register(skill);
  assert.throws(() => registry.transition(skill.skillId, SkillStatus.ACTIVE, { manual: true }), /SKILL_TRANSITION_FORBIDDEN/);
  registry.transition(skill.skillId, SkillStatus.WIKI_SUPPORTED, { reasonCode: 'WIKI_SUPPORTED' });
  registry.transition(skill.skillId, SkillStatus.REPLAY_FAILED, { reasonCode: 'REPLAY_FAILED' });
  assert.throws(() => registry.transition(skill.skillId, SkillStatus.ACTIVE), /SKILL_TRANSITION_FORBIDDEN/);

  const passed = new SkillRegistry();
  passed.register(skill);
  passed.transition(skill.skillId, SkillStatus.WIKI_SUPPORTED);
  passed.transition(skill.skillId, SkillStatus.REPLAY_PASSED);
  assert.throws(() => passed.transition(skill.skillId, SkillStatus.WIKI_SUPPORTED), /SKILL_TRANSITION_FORBIDDEN/);
  assert.throws(() => passed.transition(skill.skillId, SkillStatus.ACTIVE), /SKILL_ACTIVE_REQUIRES_GOVERNED_ACTIVATION/);
  assert.equal(passed.activate(skill.skillId).status, SkillStatus.ACTIVE);
});

test('Case D: failed skill keeps Wiki knowledge and writes impact provenance', async () => {
  const compiler = new ExperienceCompiler();
  const experiences = [1, 2, 3].map((i) => compiler.compile({
    timestamp: `2026-08-31T04:0${i}:00.000Z`, clientType: 'dsh', taskType: `t${i}`, backendType: 'dify', backendId: 'b', model: 'm',
    contextAmplification: 1.5, checkpointCreated: true, success: true, policyVersion: 'v2',
  }));
  const pattern = new PatternMiner({ minimumStrongEvidence: 3, promotionThreshold: 0.1 }).mine(experiences)
    .find((p) => p.semanticKey === 'checkpoint-reduces-backend-context');
  const wiki = new WikiMaintainer();
  wiki.create(pattern);
  const impact = new PatternImpactTracker();
  const skill = candidate();
  impact.record({ patternId: pattern.patternId, targetType: 'SkillCandidate', targetId: skill.skillId, stage: 'Replay', outcome: 'REPLAY_FAILED' });
  assert.ok(wiki.latest(pattern.patternId));
  assert.equal(impact.query({ patternId: pattern.patternId, outcome: 'REPLAY_FAILED' }).length, 1);
});
