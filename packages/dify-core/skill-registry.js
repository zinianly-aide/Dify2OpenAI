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

const AUTOMATIC_TARGETS = new Set([
  SkillStatus.WIKI_SUPPORTED,
  SkillStatus.REPLAY_PASSED,
  SkillStatus.REPLAY_FAILED,
  SkillStatus.NEEDS_REVIEW,
]);

const ALLOWED_TRANSITIONS = Object.freeze({
  [SkillStatus.DRAFT]: new Set([SkillStatus.WIKI_SUPPORTED, SkillStatus.DEPRECATED]),
  [SkillStatus.WIKI_SUPPORTED]: new Set([SkillStatus.REPLAY_PASSED, SkillStatus.REPLAY_FAILED, SkillStatus.NEEDS_REVIEW, SkillStatus.DEPRECATED]),
  [SkillStatus.REPLAY_PASSED]: new Set([SkillStatus.ACTIVE, SkillStatus.DEPRECATED]),
  [SkillStatus.REPLAY_FAILED]: new Set([SkillStatus.DEPRECATED]),
  [SkillStatus.NEEDS_REVIEW]: new Set([SkillStatus.DEPRECATED]),
  [SkillStatus.ACTIVE]: new Set([SkillStatus.ROLLED_BACK, SkillStatus.DEPRECATED]),
  [SkillStatus.ROLLED_BACK]: new Set([SkillStatus.DEPRECATED]),
  [SkillStatus.DEPRECATED]: new Set(),
});

function entry(candidate, status, history) {
  return Object.freeze({ candidate, status, history: Object.freeze(history) });
}

export class SkillRegistry {
  constructor() { this.entries = new Map(); }

  register(candidate, { status = SkillStatus.DRAFT } = {}) {
    if (status !== SkillStatus.DRAFT) throw new Error('SKILL_REGISTER_STATUS_FORBIDDEN');
    const existing = this.entries.get(candidate.skillId);
    if (existing) return existing;
    const created = entry(candidate, SkillStatus.DRAFT, [Object.freeze({ status: SkillStatus.DRAFT, reasonCode: 'REGISTERED' })]);
    this.entries.set(candidate.skillId, created);
    return created;
  }

  get(skillId) { return this.entries.get(skillId) ?? null; }

  transition(skillId, status, { reasonCode = 'UNSPECIFIED', manual = false } = {}) {
    const current = this.get(skillId);
    if (!current) throw new Error(`SKILL_NOT_FOUND:${skillId}`);
    if (!Object.values(SkillStatus).includes(status)) throw new Error('SKILL_STATUS_INVALID');
    if (!ALLOWED_TRANSITIONS[current.status]?.has(status)) {
      throw new Error(`SKILL_TRANSITION_FORBIDDEN:${current.status}->${status}`);
    }
    if (status === SkillStatus.ACTIVE && !manual) throw new Error('SKILL_ACTIVE_REQUIRES_GOVERNED_ACTIVATION');
    if (!manual && !AUTOMATIC_TARGETS.has(status)) throw new Error('SKILL_AUTO_PRODUCTION_TRANSITION_FORBIDDEN');
    const history = [...current.history, Object.freeze({ status, reasonCode })];
    const next = entry(current.candidate, status, history);
    this.entries.set(skillId, next);
    return next;
  }

  activate(skillId, { reasonCode = 'MANUAL_GOVERNED_ACTIVATION' } = {}) {
    return this.transition(skillId, SkillStatus.ACTIVE, { manual: true, reasonCode });
  }

  rollback(skillId, { reasonCode = 'MANUAL_SKILL_ROLLBACK' } = {}) {
    return this.transition(skillId, SkillStatus.ROLLED_BACK, { manual: true, reasonCode });
  }

  deprecate(skillId, { reasonCode = 'MANUAL_DEPRECATION' } = {}) {
    return this.transition(skillId, SkillStatus.DEPRECATED, { manual: true, reasonCode });
  }

  list({ status } = {}) {
    return [...this.entries.values()].filter((item) => status === undefined || item.status === status)
      .sort((a, b) => a.candidate.skillId.localeCompare(b.candidate.skillId));
  }
}

export const SKILL_ALLOWED_TRANSITIONS = ALLOWED_TRANSITIONS;
