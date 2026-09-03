import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ExperienceCompiler,
  KnowledgeScope,
  PatternMiner,
  PatternStatus,
  SkillCandidateSelector,
  SkillProposer,
  SkillScope,
  createKnowledgePattern,
  deterministicSkillProposal,
} from '../packages/dify-core/index.js';

const compiler = new ExperienceCompiler();

function experience(i, overrides = {}) {
  return compiler.compile({
    timestamp: `2026-08-31T03:${String(i).padStart(2, '0')}:00.000Z`,
    clientType: ['dsh', 'codex', 'openai-compatible'][i % 3],
    taskType: `task-${i}`,
    backendType: 'dify',
    backendId: `backend-${i % 3}`,
    model: `model-${i % 3}`,
    contextAmplification: 1.5,
    checkpointCreated: true,
    success: true,
    policyVersion: 'v2',
    ...overrides,
  });
}

function strongPatterns() {
  const miner = new PatternMiner({ minimumStrongEvidence: 3, promotionThreshold: 0.1 });
  return miner.mine([experience(1), experience(2), experience(3), experience(4), experience(5), experience(6)]);
}

test('STRONG patterns produce candidate groups while OBSERVED and CONTRADICTED are blocked', () => {
  const selector = new SkillCandidateSelector({ promotionThreshold: 0.1, minimumEvidence: 3 });
  const strong = strongPatterns();
  assert.ok(selector.select(strong).length > 0);
  const observed = strong.map((p) => ({ ...p, status: PatternStatus.OBSERVED }));
  const contradicted = strong.map((p) => ({ ...p, status: PatternStatus.CONTRADICTED }));
  assert.equal(selector.select(observed).length, 0);
  assert.equal(selector.select(contradicted).length, 0);
});

test('Dify-specific knowledge stays backend-specific', async () => {
  const pattern = createKnowledgePattern({
    semanticKey: 'dify-session-management',
    title: 'Dify session management',
    category: 'BACKEND',
    scope: KnowledgeScope.BACKEND_SPECIFIC,
    conditions: { semanticRule: 'dify-session-management' },
    observations: ['matched:8'],
    hypothesis: 'Dify conversation lifecycle needs backend-specific handling.',
    rootCause: 'Dify conversation state is backend-local.',
    effectiveStrategies: ['rotate-dify-conversation-safely'],
    failedStrategies: ['reuse-conversation-across-backends'],
    evidence: { observationCount: 8, successCount: 8, failureCount: 0 },
    confidence: 0.95,
    impact: 0.9,
    transferability: 0.4,
    sourceExperienceIds: ['exp-a', 'exp-b'],
    status: PatternStatus.STRONG,
    promotionScore: 0.8,
    promotionSignal: 'SKILL_CANDIDATE',
  });
  const selector = new SkillCandidateSelector({ promotionThreshold: 0.5, minimumEvidence: 3 });
  const group = selector.select([pattern])[0];
  assert.equal(group.scope, SkillScope.BACKEND_SPECIFIC);
  const candidate = await new SkillProposer().propose(group);
  assert.equal(candidate.scope, SkillScope.BACKEND_SPECIFIC);
});

test('multiple related patterns merge into one candidate with full provenance', async () => {
  const selector = new SkillCandidateSelector({ promotionThreshold: 0.1, minimumEvidence: 3 });
  const group = selector.select(strongPatterns()).find((item) => item.family === 'context-management');
  assert.ok(group.patterns.length >= 2);
  const candidate = await new SkillProposer().propose(group);
  assert.deepEqual(candidate.sourcePatternIds, group.patterns.map((p) => p.patternId).sort());
  assert.deepEqual(candidate.purpose.sourcePatternIds, candidate.sourcePatternIds);
});

test('same deterministic input produces stable skill provenance and content hash', async () => {
  const selector = new SkillCandidateSelector({ promotionThreshold: 0.1, minimumEvidence: 3 });
  const group = selector.select(strongPatterns())[0];
  const proposer = new SkillProposer();
  const a = await proposer.propose(group);
  const b = await proposer.propose(group);
  assert.equal(a.skillId, b.skillId);
  assert.equal(a.contentHash, b.contentHash);
  assert.deepEqual(a.sourcePatternIds, b.sourcePatternIds);
});

test('malformed proposer output is rejected', async () => {
  const selector = new SkillCandidateSelector({ promotionThreshold: 0.1, minimumEvidence: 3 });
  const group = selector.select(strongPatterns())[0];
  await assert.rejects(() => new SkillProposer({ proposalProvider: async () => ({ bad: true }) }).propose(group), /SKILL_PROPOSAL_SCHEMA_INVALID/);
});

test('oversized skill is rejected', async () => {
  const selector = new SkillCandidateSelector({ promotionThreshold: 0.1, minimumEvidence: 3 });
  const group = selector.select(strongPatterns())[0];
  const provider = async (input) => ({ ...deterministicSkillProposal(input), instructions: 'x'.repeat(5000) });
  await assert.rejects(() => new SkillProposer({ proposalProvider: provider, maxInstructionChars: 1000 }).propose(group), /SKILL_PROPOSAL_SIZE_INVALID/);
});

test('backend-specific proposal cannot be upgraded to GENERAL by proposer', async () => {
  const pattern = createKnowledgePattern({
    semanticKey: 'dify-session-management', title: 'Dify session', category: 'BACKEND', scope: KnowledgeScope.BACKEND_SPECIFIC,
    evidence: { observationCount: 8, successCount: 8, failureCount: 0 }, confidence: 0.9, impact: 0.9, transferability: 0.4,
    sourceExperienceIds: ['exp-a'], status: PatternStatus.STRONG, promotionScore: 0.8, promotionSignal: 'SKILL_CANDIDATE',
    effectiveStrategies: ['safe-rotation'], failedStrategies: [],
  });
  const group = new SkillCandidateSelector({ promotionThreshold: 0.5, minimumEvidence: 3 }).select([pattern])[0];
  const provider = async (input) => ({ ...deterministicSkillProposal(input), scope: SkillScope.GENERAL, purpose: { ...deterministicSkillProposal(input).purpose, scope: SkillScope.GENERAL } });
  await assert.rejects(() => new SkillProposer({ proposalProvider: provider }).propose(group), /SKILL_PROPOSAL_SCOPE_MISMATCH|SKILL_NEGATIVE_TRANSFER_SCOPE_REJECTED/);
});
