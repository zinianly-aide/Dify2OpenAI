import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EvolutionController,
  ExperienceCompiler,
  GatewayKnowledgeStore,
  PatternImpactTracker,
  PatternMiner,
  ReplayRunner,
  ReplayVariant,
  RuntimeSkillSelector,
  SkillCandidateSelector,
  SkillEvaluator,
  SkillProposer,
  SkillRegistry,
  SkillReplay,
  SkillStatus,
  WikiMaintainer,
  createGatewayWikiSnapshot,
} from '../packages/dify-core/index.js';

const compiler = new ExperienceCompiler();

function runtimeExperiences() {
  return Array.from({ length: 9 }, (_, i) => compiler.compile({
    timestamp: `2026-08-31T05:${String(i).padStart(2, '0')}:00.000Z`,
    clientType: ['dsh', 'codex', 'openai-compatible'][i % 3],
    taskType: 'coding-agent',
    backendType: 'dify',
    backendId: `backend-${i % 3}`,
    model: `model-${i % 3}`,
    contextUtilization: 0.82,
    contextAmplification: 1.55,
    checkpointCreated: true,
    toolCountBefore: 18,
    toolCountAfter: 9,
    fallbackUsed: true,
    routingReasonCodes: ['BACKEND_UNAVAILABLE'],
    success: true,
    backendPromptTokens: 6000,
    latencyMs: 800,
    estimatedCost: 0.01,
    policyVersion: 'v2',
  }));
}

function replayCase({ taskId = 'task-a' } = {}) {
  return {
    taskId,
    client: 'dsh', model: 'model-0', backend: 'dify', toolAvailability: ['read', 'write'], contextBudget: 32000,
    evaluationCriteria: ['task-success', 'tool-success'],
  };
}

class E2EReplayRunner extends ReplayRunner {
  constructor({ candidateSuccess = 0.84 } = {}) { super({ runnerId: `e2e-runner-${candidateSuccess}` }); this.candidateSuccess = candidateSuccess; }
  async execute({ variant }) {
    if (variant === ReplayVariant.NO_SKILL) return { taskSuccess: 0.70, toolSuccess: 0.80, toolRetry: 0.20, contextUsage: 0.80, tokenUsage: 1000, latency: 1000, cost: 0.02, errorRate: 0.10 };
    if (variant === ReplayVariant.BASELINE_SKILL) return { taskSuccess: 0.76, toolSuccess: 0.84, toolRetry: 0.16, contextUsage: 0.76, tokenUsage: 950, latency: 980, cost: 0.019, errorRate: 0.08 };
    return { taskSuccess: this.candidateSuccess, toolSuccess: 0.90, toolRetry: 0.10, contextUsage: 0.70, tokenUsage: 920, latency: 970, cost: 0.018, errorRate: 0.05 };
  }
}

test('success loop: runtime evidence to active selected skill to new outcome provenance', async () => {
  const knowledge = new GatewayKnowledgeStore();
  const experiences = runtimeExperiences();
  experiences.forEach((item) => knowledge.appendExperience(item));

  const patterns = new PatternMiner({ minimumStrongEvidence: 6, promotionThreshold: 0.2 }).mine(experiences);
  const wiki = new WikiMaintainer();
  patterns.forEach((pattern) => wiki.create(pattern));
  const wikiSnapshot = createGatewayWikiSnapshot(wiki.listLatest());
  assert.ok(wikiSnapshot.strongPatternCount >= 2);

  const group = new SkillCandidateSelector({ promotionThreshold: 0.2, minimumEvidence: 6 })
    .select(patterns).find((item) => item.family === 'context-management');
  assert.ok(group);
  const candidate = await new SkillProposer().propose(group);

  const replay = await new SkillReplay().run({ skillId: candidate.skillId, scope: candidate.scope, cases: [replayCase()], runner: new E2EReplayRunner(), candidateSkill: candidate });
  const evaluation = new SkillEvaluator().evaluate(replay);
  assert.equal(evaluation.status, SkillStatus.REPLAY_PASSED);

  const registry = new SkillRegistry();
  registry.register(candidate);
  registry.transition(candidate.skillId, SkillStatus.WIKI_SUPPORTED, { reasonCode: 'WIKI_SUPPORTED' });
  registry.transition(candidate.skillId, SkillStatus.REPLAY_PASSED, { reasonCode: evaluation.reasonCode });
  registry.activate(candidate.skillId, { reasonCode: 'MANUAL_APPROVAL_FOR_E2E' });

  const selected = new RuntimeSkillSelector().select(registry, {
    clientType: 'dsh', backendType: 'dify', modelFamily: 'model', taskType: 'coding-agent', requiredCapabilities: ['tools'],
  });
  assert.equal(selected.length, 1);
  assert.equal(selected[0].skillId, candidate.skillId);
  assert.equal('patterns' in selected[0], false);

  const newOutcome = compiler.compile({
    timestamp: '2026-08-31T05:30:00.000Z', clientType: 'dsh', taskType: 'coding-agent', backendType: 'dify', backendId: 'backend-0', model: 'model-0',
    contextAmplification: 1.2, checkpointCreated: true, success: true, policyVersion: 'v2', latencyMs: 700, backendPromptTokens: 5000,
  }, { sourceType: 'RuntimeOutcome', sourceId: candidate.skillId });
  knowledge.appendExperience(newOutcome);

  const impact = new PatternImpactTracker();
  for (const patternId of candidate.sourcePatternIds) {
    impact.record({ patternId, targetType: 'SkillCandidate', targetId: candidate.skillId, stage: 'ProductionOutcome', outcome: 'SUCCESS' });
  }
  assert.equal(impact.query({ targetType: 'SkillCandidate', outcome: 'SUCCESS' }).length, candidate.sourcePatternIds.length);
});

test('failure loop: replay regression keeps Wiki and becomes impact evidence', async () => {
  const experiences = runtimeExperiences();
  const patterns = new PatternMiner({ minimumStrongEvidence: 6, promotionThreshold: 0.2 }).mine(experiences);
  const wiki = new WikiMaintainer();
  patterns.forEach((pattern) => wiki.create(pattern));
  const before = createGatewayWikiSnapshot(wiki.listLatest()).contentHash;

  const group = new SkillCandidateSelector({ promotionThreshold: 0.2, minimumEvidence: 6 })
    .select(patterns).find((item) => item.family === 'backend-routing');
  assert.ok(group);
  const candidate = await new SkillProposer().propose(group);
  const replay = await new SkillReplay().run({ skillId: candidate.skillId, scope: candidate.scope, cases: [replayCase()], runner: new E2EReplayRunner({ candidateSuccess: 0.60 }), candidateSkill: candidate });
  const evaluation = new SkillEvaluator().evaluate(replay);
  assert.equal(evaluation.status, SkillStatus.REPLAY_FAILED);

  const registry = new SkillRegistry();
  registry.register(candidate);
  registry.transition(candidate.skillId, SkillStatus.WIKI_SUPPORTED, { reasonCode: 'WIKI_SUPPORTED' });
  registry.transition(candidate.skillId, SkillStatus.REPLAY_FAILED, { reasonCode: evaluation.reasonCode });

  const impact = new PatternImpactTracker();
  candidate.sourcePatternIds.forEach((patternId) => impact.record({ patternId, targetType: 'SkillCandidate', targetId: candidate.skillId, stage: 'Replay', outcome: 'REPLAY_FAILED', reasonCodes: [evaluation.reasonCode] }));
  const after = createGatewayWikiSnapshot(wiki.listLatest()).contentHash;
  assert.equal(before, after);
  assert.equal(impact.query({ outcome: 'REPLAY_FAILED' }).length, candidate.sourcePatternIds.length);
});

test('Policy and Skill evolution freeze, disable, rollback and pins are independent and audited', async () => {
  const controller = new EvolutionController();
  controller.freezeSkillEvolution('SKILL_FREEZE_TEST');
  assert.equal((await controller.runScheduledAnalysis('patternMining', async () => 'skill-ran')).status, 'FROZEN');
  assert.equal((await controller.runScheduledAnalysis('policyAnalysis', async () => 'policy-ran')).status, 'EXECUTED');

  controller.resumeSkillEvolution();
  controller.freezePolicyEvolution('POLICY_FREEZE_TEST');
  assert.equal((await controller.runScheduledAnalysis('skillCandidateDiscovery', async () => 'skill-ran')).status, 'EXECUTED');
  assert.equal((await controller.runScheduledAnalysis('policyAnalysis', async () => 'policy-ran')).status, 'FROZEN');

  controller.resumePolicyEvolution();
  controller.disableAnalysis('wikiMaintenance');
  assert.equal((await controller.runScheduledAnalysis('wikiMaintenance', async () => 'should-not-run')).status, 'DISABLED');
  controller.enableAnalysis('wikiMaintenance');
  controller.pinPolicyVersion('v2');
  controller.pinSkillVersion('skill-v1');
  controller.disableAutoPromotion(true);

  let rolledPolicy = false;
  controller.manualPolicyRollback({ fromVersion: 'v3', toVersion: 'v2', execute: () => { rolledPolicy = true; return 'ok'; } });
  assert.equal(rolledPolicy, true);

  const registry = new SkillRegistry();
  const groupPatterns = new PatternMiner({ minimumStrongEvidence: 6, promotionThreshold: 0.2 }).mine(runtimeExperiences());
  const group = new SkillCandidateSelector({ promotionThreshold: 0.2, minimumEvidence: 6 }).select(groupPatterns)[0];
  const candidate = await new SkillProposer().propose(group);
  registry.register(candidate);
  registry.transition(candidate.skillId, SkillStatus.WIKI_SUPPORTED, { reasonCode: 'WIKI_SUPPORTED' });
  registry.transition(candidate.skillId, SkillStatus.REPLAY_PASSED, { reasonCode: 'REPLAY_PASSED' });
  registry.activate(candidate.skillId, { reasonCode: 'MANUAL_APPROVAL' });
  controller.manualSkillRollback({ registry, skillId: candidate.skillId });
  assert.equal(registry.get(candidate.skillId).status, SkillStatus.ROLLED_BACK);

  const actions = new Set(controller.auditLog().map((entry) => entry.action));
  for (const action of ['SKILL_EVOLUTION_FROZEN', 'POLICY_EVOLUTION_FROZEN', 'POLICY_VERSION_PINNED', 'SKILL_VERSION_PINNED', 'AUTO_PROMOTION_CHANGED', 'MANUAL_POLICY_ROLLBACK', 'MANUAL_SKILL_ROLLBACK']) {
    assert.equal(actions.has(action), true, `missing audit action ${action}`);
  }
});
