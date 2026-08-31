import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PatternImpactTracker,
  PatternMiner,
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
    noSkill: { taskSuccess: 0.70, toolSuccess: 0.80, toolRetry: 0.20, contextUsage: 0.80, tokenUsage: 1000, latency: 1000, cost: 0.02, errorRate: 0.10 },
    baselineSkill: { taskSuccess: 0.76, toolSuccess: 0.84, toolRetry: 0.16, contextUsage: 0.76, tokenUsage: 950, latency: 980, cost: 0.019, errorRate: 0.08 },
    candidateSkill: { taskSuccess: 0.84, toolSuccess: 0.90, toolRetry: 0.10, contextUsage: 0.70, tokenUsage: 920, latency: 970, cost: 0.018, errorRate: 0.05 },
    ...overrides,
  };
}

test('replay is deterministic where inputs are identical', () => {
  const skill = candidate();
  const replay = new SkillReplay();
  const a = replay.run({ skillId: skill.skillId, scope: skill.scope, cases: [replayCase()] });
  const b = replay.run({ skillId: skill.skillId, scope: skill.scope, cases: [replayCase()] });
  assert.equal(a.replayId, b.replayId);
  assert.equal(a.contentHash, b.contentHash);
});

test('Case A: candidate improves benchmark and reaches REPLAY_PASSED', () => {
  const skill = candidate();
  const result = new SkillEvaluator().evaluate(new SkillReplay().run({ skillId: skill.skillId, scope: skill.scope, cases: [replayCase()] }));
  assert.equal(result.status, SkillStatus.REPLAY_PASSED);
  assert.ok(result.transferScore > 0);
});

test('quality regression fails only when quality is actually observed', () => {
  const skill = candidate();
  const observed = replayCase({
    noSkill: { ...replayCase().noSkill, qualityScore: 0.90 },
    candidateSkill: { ...replayCase().candidateSkill, qualityScore: 0.80 },
  });
  const result = new SkillEvaluator().evaluate(new SkillReplay().run({ skillId: skill.skillId, scope: skill.scope, cases: [observed] }));
  assert.equal(result.status, SkillStatus.REPLAY_FAILED);
  assert.equal(result.reasonCode, 'QUALITY_REGRESSION');
  const unobserved = new SkillReplay().run({ skillId: skill.skillId, scope: skill.scope, cases: [replayCase()] });
  assert.equal('qualityScore' in unobserved.cases[0].candidateSkill, false);
});

test('Case B: cross-model negative transfer becomes NEEDS_REVIEW with scope downgrade', () => {
  const skill = candidate(SkillScope.GENERAL);
  const cases = [
    replayCase({ taskId: 'a', model: 'model-a', noSkill: { ...replayCase().noSkill, taskSuccess: 0.70 }, candidateSkill: { ...replayCase().candidateSkill, taskSuccess: 0.85 } }),
    replayCase({ taskId: 'b', model: 'model-b', noSkill: { ...replayCase().noSkill, taskSuccess: 0.80 }, candidateSkill: { ...replayCase().candidateSkill, taskSuccess: 0.68 } }),
  ];
  const result = new SkillEvaluator().evaluate(new SkillReplay().run({ skillId: skill.skillId, scope: skill.scope, cases }));
  assert.equal(result.status, SkillStatus.NEEDS_REVIEW);
  assert.equal(result.reasonCode, 'NEGATIVE_TRANSFER_SCOPE_REVIEW');
  assert.equal(result.suggestedScope, SkillScope.MODEL_SPECIFIC);
});

test('Case C: token reduction does not hide task success regression', () => {
  const skill = candidate();
  const item = replayCase({
    noSkill: { ...replayCase().noSkill, taskSuccess: 0.80, tokenUsage: 1000 },
    candidateSkill: { ...replayCase().candidateSkill, taskSuccess: 0.72, tokenUsage: 800 },
  });
  const result = new SkillEvaluator().evaluate(new SkillReplay().run({ skillId: skill.skillId, scope: skill.scope, cases: [item] }));
  assert.equal(result.status, SkillStatus.REPLAY_FAILED);
  assert.equal(result.reasonCode, 'TASK_SUCCESS_REGRESSION');
  assert.equal(result.environment[0].tokenDelta, -200);
});

test('SkillRegistry cannot auto-transition to ACTIVE', () => {
  const skill = candidate();
  const registry = new SkillRegistry();
  registry.register(skill);
  registry.transition(skill.skillId, SkillStatus.WIKI_SUPPORTED, { reasonCode: 'WIKI_SUPPORTED' });
  registry.transition(skill.skillId, SkillStatus.REPLAY_PASSED, { reasonCode: 'REPLAY_PASSED' });
  assert.equal(registry.get(skill.skillId).status, SkillStatus.REPLAY_PASSED);
  assert.throws(() => registry.transition(skill.skillId, SkillStatus.ACTIVE), /SKILL_AUTO_PRODUCTION_TRANSITION_FORBIDDEN/);
});

test('Case D: failed skill keeps Wiki knowledge and writes impact provenance', () => {
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
