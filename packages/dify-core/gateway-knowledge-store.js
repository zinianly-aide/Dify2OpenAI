import { canonicalJson, sha256 } from './canonical.js';
import { assertKnowledgePrivacy } from './knowledge-experience.js';

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) freeze(child);
  return value;
}

export class GatewayKnowledgeStore {
  constructor() { this.experiences = new Map(); }

  appendExperience(experience) {
    assertKnowledgePrivacy(experience);
    const existing = this.experiences.get(experience.experienceId);
    if (existing) return existing;
    const stored = freeze(structuredClone(experience));
    this.experiences.set(stored.experienceId, stored);
    return stored;
  }

  getExperience(experienceId) { return this.experiences.get(experienceId) ?? null; }

  queryExperiences(filters = {}) {
    return [...this.experiences.values()].filter((experience) => Object.entries(filters).every(([key, value]) => {
      if (value === undefined) return true;
      return experience[key] === value;
    })).sort((a, b) => a.experienceId.localeCompare(b.experienceId));
  }

  createSnapshot(filters = {}) {
    const experiences = this.queryExperiences(filters);
    assertKnowledgePrivacy(experiences);
    const contentHash = sha256(canonicalJson(experiences));
    return freeze({
      snapshotId: `knowledge-${contentHash.slice(0, 24)}`,
      contentHash,
      experienceCount: experiences.length,
      experiences: [...experiences],
    });
  }
}
