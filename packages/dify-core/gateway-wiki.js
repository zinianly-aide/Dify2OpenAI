import { canonicalJson, sha256 } from './canonical.js';
import { PatternStatus } from './knowledge-pattern.js';

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) freeze(child);
  return value;
}

export function createGatewayWikiSnapshot(records = [], { createdAt = 'unknown' } = {}) {
  const patterns = [...records]
    .map((record) => ({
      patternId: record.patternId,
      patternVersion: record.patternVersion,
      pattern: record.pattern,
    }))
    .sort((a, b) => a.patternId.localeCompare(b.patternId));
  const contentHash = sha256(canonicalJson(patterns));
  return freeze({
    wikiSnapshotId: `wiki-${contentHash.slice(0, 24)}`,
    patternCount: patterns.length,
    strongPatternCount: patterns.filter((item) => item.pattern.status === PatternStatus.STRONG).length,
    skillCandidateCount: patterns.filter((item) => item.pattern.promotionSignal === 'SKILL_CANDIDATE').length,
    contentHash,
    createdAt,
    patterns,
  });
}
