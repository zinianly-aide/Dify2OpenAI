import { canonicalJson, sha256 } from './canonical.js';
import { assertKnowledgePrivacy } from './knowledge-experience.js';

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) freeze(child);
  return value;
}

export class PatternStore {
  constructor() { this.patterns = new Map(); }

  upsert(pattern) {
    assertKnowledgePrivacy(pattern);
    const stored = freeze(structuredClone(pattern));
    this.patterns.set(stored.patternId, stored);
    return stored;
  }

  getPattern(patternId) { return this.patterns.get(patternId) ?? null; }

  listPatterns(filters = {}) {
    return [...this.patterns.values()]
      .filter((pattern) => Object.entries(filters).every(([key, value]) => value === undefined || pattern[key] === value))
      .sort((a, b) => a.patternId.localeCompare(b.patternId));
  }

  createSnapshot(filters = {}) {
    const patterns = this.listPatterns(filters);
    const contentHash = sha256(canonicalJson(patterns));
    return freeze({
      snapshotId: `patterns-${contentHash.slice(0, 24)}`,
      contentHash,
      patternCount: patterns.length,
      patterns: [...patterns],
    });
  }
}
