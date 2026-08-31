import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ExperienceCompiler,
  KnowledgeScope,
  PatternImpactTracker,
  PatternMiner,
  PatternStatus,
  WikiMaintainer,
  createGatewayWikiSnapshot,
} from '../packages/dify-core/index.js';

const compiler = new ExperienceCompiler();

function experience(i, overrides = {}) {
  return compiler.compile({
    timestamp: `2026-08-31T02:${String(i).padStart(2, '0')}:00.000Z`,
    clientType: 'dsh',
    taskType: `task-${i}`,
    backendType: 'dify',
    backendId: 'backend-a',
    model: 'model-a',
    contextAmplification: 1.6,
    checkpointCreated: true,
    success: true,
    policyVersion: 'v2',
    ...overrides,
  });
}

function basePattern(overrides = {}) {
  const miner = new PatternMiner({ minimumStrongEvidence: 3, promotionThreshold: 0.1 });
  const patterns = miner.mine([
    experience(1, overrides), experience(2, overrides), experience(3, overrides),
  ]);
  return patterns.find((p) => p.semanticKey === 'checkpoint-reduces-backend-context');
}

test('pattern history is append-only and strengthen creates a new version', () => {
  const wiki = new WikiMaintainer();
  const pattern = basePattern();
  const created = wiki.create(pattern, { timestamp: '2026-08-31T02:10:00.000Z' });
  const strengthened = wiki.evolve(pattern.patternId, 'STRENGTHENED', { confidence: 0.95 }, {
    evidenceDelta: { observationCount: 2, successCount: 2, lastSeen: '2026-08-31T02:12:00.000Z' },
    timestamp: '2026-08-31T02:12:00.000Z',
  });
  assert.notEqual(created.patternVersion, strengthened.patternVersion);
  assert.equal(strengthened.previousVersion, created.patternVersion);
  assert.equal(wiki.listHistory(pattern.patternId).length, 2);
  assert.equal(wiki.getVersion(pattern.patternId, created.patternVersion).patternVersion, created.patternVersion);
});

test('contradiction is preserved as a new version', () => {
  const wiki = new WikiMaintainer();
  const pattern = basePattern();
  const created = wiki.create(pattern);
  const contradicted = wiki.evolve(pattern.patternId, 'CONTRADICTED', {}, {
    evidenceDelta: { observationCount: 2, failureCount: 2 },
  });
  assert.equal(contradicted.pattern.status, PatternStatus.CONTRADICTED);
  assert.equal(wiki.getVersion(pattern.patternId, created.patternVersion).pattern.status, pattern.status);
  assert.equal(wiki.listHistory(pattern.patternId).length, 2);
});

test('deprecated pattern remains queryable', () => {
  const wiki = new WikiMaintainer();
  const pattern = basePattern();
  wiki.create(pattern);
  const deprecated = wiki.evolve(pattern.patternId, 'DEPRECATED');
  assert.equal(deprecated.pattern.status, PatternStatus.DEPRECATED);
  assert.equal(wiki.latest(pattern.patternId).pattern.patternId, pattern.patternId);
  assert.equal(wiki.listHistory(pattern.patternId).length, 2);
});

test('policy and skill rollback append impact evidence and do not delete wiki knowledge', () => {
  const wiki = new WikiMaintainer();
  const impact = new PatternImpactTracker();
  const pattern = basePattern();
  wiki.create(pattern);
  impact.record({ patternId: pattern.patternId, targetType: 'PolicyCandidate', targetId: 'policy-v3', stage: 'Canary', outcome: 'ROLLED_BACK', rollback: true });
  impact.record({ patternId: pattern.patternId, targetType: 'SkillCandidate', targetId: 'skill-v2', stage: 'Replay', outcome: 'REPLAY_FAILED', rollback: true });
  assert.ok(wiki.latest(pattern.patternId));
  assert.equal(wiki.listHistory(pattern.patternId).length, 1);
  assert.equal(impact.query({ patternId: pattern.patternId }).length, 2);
});

test('scope promotion requires deterministic evidence', () => {
  const wiki = new WikiMaintainer();
  const miner = new PatternMiner();
  const pattern = miner.mine([experience(1, { versionSpecific: true })])
    .find((p) => p.semanticKey === 'checkpoint-reduces-backend-context');
  assert.equal(pattern.scope, KnowledgeScope.VERSION_SPECIFIC);
  assert.equal(pattern.evidence.observationCount, 1);
  wiki.create(pattern);
  assert.throws(() => wiki.promoteScope(pattern.patternId, KnowledgeScope.BACKEND_SPECIFIC, {
    evidenceDelta: { observationCount: 0, backendDiversity: 0 },
  }), /SCOPE_PROMOTION_EVIDENCE_INSUFFICIENT/);
  const promoted = wiki.promoteScope(pattern.patternId, KnowledgeScope.BACKEND_SPECIFIC, {
    evidenceDelta: { observationCount: 2, successCount: 2, backendDiversity: 1 },
  });
  assert.equal(promoted.pattern.scope, KnowledgeScope.BACKEND_SPECIFIC);
});

test('same wiki state produces same content hash independent of createdAt', () => {
  const firstWiki = new WikiMaintainer();
  const secondWiki = new WikiMaintainer();
  const pattern = basePattern();
  firstWiki.create(pattern, { timestamp: '2026-08-31T02:10:00.000Z' });
  secondWiki.create(pattern, { timestamp: '2026-08-31T03:10:00.000Z' });
  const first = createGatewayWikiSnapshot(firstWiki.listLatest(), { createdAt: '2026-08-31T04:00:00.000Z' });
  const second = createGatewayWikiSnapshot(secondWiki.listLatest(), { createdAt: '2026-08-31T05:00:00.000Z' });
  assert.equal(first.contentHash, second.contentHash);
  assert.equal(first.wikiSnapshotId, second.wikiSnapshotId);
});

test('impact lineage remains queryable without raw target identifiers', () => {
  const tracker = new PatternImpactTracker();
  const pattern = basePattern();
  const record = tracker.record({
    patternId: pattern.patternId,
    targetType: 'PolicyCandidate',
    targetId: 'private-policy-candidate-id',
    stage: 'Replay',
    outcome: 'PASSED',
    reasonCodes: ['REPLAY_PASSED'],
    timestamp: '2026-08-31T02:20:00.000Z',
  });
  const lineage = tracker.query({ patternId: pattern.patternId, targetType: 'PolicyCandidate' });
  assert.equal(lineage.length, 1);
  assert.equal(lineage[0].impactId, record.impactId);
  assert.equal(JSON.stringify(lineage).includes('private-policy-candidate-id'), false);
});
