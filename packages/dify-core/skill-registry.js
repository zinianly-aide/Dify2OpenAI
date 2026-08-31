export const SkillStatus = Object.freeze({
  DRAFT: 'DRAFT',
  WIKI_SUPPORTED: 'WIKI_SUPPORTED',
  REPLAY_PASSED: 'REPLAY_PASSED',
  REPLAY_FAILED: 'REPLAY_FAILED',
  NEEDS_REVIEW: 'NEEDS_REVIEW',
  ACTIVE: 'ACTIVE',
  ROLLED_BACK: 'ROLLED_BACK',
  DEPRECATED: 'DEPRECATED',
});

const AUTO_ALLOWED = new Set([
  SkillStatus.DRAFT,
  SkillStatus.WIKI_SUPPORTED,
  SkillStatus.REPLAY_PASSED,
  SkillStatus.REPLAY_FAILED,
  SkillStatus.NEEDS_REVIEW,
]);

export class SkillRegistry {
  constructor() { this.entries = new Map(); }

  register(candidate, { status = SkillStatus.DRAFT } = {}) {
    const existing = this.entries.get(candidate.skillId);
    if (existing) return existing;
    const entry = Object.freeze({ candidate, status, history: Object.freeze([{ status, reasonCode: 'REGISTERED' }]) });
    this.entries.set(candidate.skillId, entry);
    return entry;
  }

  get(skillId) { return this.entries.get(skillId) ?? null; }

  transition(skillId, status, { reasonCode = 'UNSPECIFIED', manual = false } = {}) {
    const current = this.get(skillId);
    if (!current) throw new Error(`SKILL_NOT_FOUND:${skillId}`);
    if (!manual && !AUTO_ALLOWED.has(status)) throw new Error('SKILL_AUTO_PRODUCTION_TRANSITION_FORBIDDEN');
    const history = Object.freeze([...current.history, Object.freeze({ status, reasonCode })]);
    const next = Object.freeze({ candidate: current.candidate, status, history });
    this.entries.set(skillId, next);
    return next;
  }

  list({ status } = {}) {
    return [...this.entries.values()].filter((entry) => status === undefined || entry.status === status)
      .sort((a, b) => a.candidate.skillId.localeCompare(b.candidate.skillId));
  }
}
