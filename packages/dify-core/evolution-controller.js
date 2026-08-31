import { canonicalJson, sha256 } from './canonical.js';
import { SkillStatus } from './skill-registry.js';

const ANALYSES = Object.freeze({
  experienceCompilation: 'skill',
  patternMining: 'skill',
  wikiMaintenance: 'skill',
  policyAnalysis: 'policy',
  skillCandidateDiscovery: 'skill',
});

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) freeze(child);
  return value;
}

export class EvolutionController {
  constructor() {
    this.policy = { enabled: true, frozen: false, pinnedVersion: null };
    this.skill = { enabled: true, frozen: false, pinnedVersion: null };
    this.autoPromotionDisabled = false;
    this.analysis = new Map(Object.keys(ANALYSES).map((name) => [name, true]));
    this.audit = [];
  }

  enableAnalysis(name) { this.#assertAnalysis(name); this.analysis.set(name, true); return this.#audit('ANALYSIS_ENABLED', { name }); }
  disableAnalysis(name) { this.#assertAnalysis(name); this.analysis.set(name, false); return this.#audit('ANALYSIS_DISABLED', { name }); }
  freezePolicyEvolution(reasonCode = 'MANUAL_FREEZE') { this.policy.frozen = true; return this.#audit('POLICY_EVOLUTION_FROZEN', { reasonCode }); }
  resumePolicyEvolution(reasonCode = 'MANUAL_RESUME') { this.policy.frozen = false; return this.#audit('POLICY_EVOLUTION_RESUMED', { reasonCode }); }
  freezeSkillEvolution(reasonCode = 'MANUAL_FREEZE') { this.skill.frozen = true; return this.#audit('SKILL_EVOLUTION_FROZEN', { reasonCode }); }
  resumeSkillEvolution(reasonCode = 'MANUAL_RESUME') { this.skill.frozen = false; return this.#audit('SKILL_EVOLUTION_RESUMED', { reasonCode }); }
  pinPolicyVersion(version) { this.policy.pinnedVersion = version; return this.#audit('POLICY_VERSION_PINNED', { version }); }
  pinSkillVersion(version) { this.skill.pinnedVersion = version; return this.#audit('SKILL_VERSION_PINNED', { version }); }
  disableAutoPromotion(disabled = true) { this.autoPromotionDisabled = disabled === true; return this.#audit('AUTO_PROMOTION_CHANGED', { disabled: this.autoPromotionDisabled }); }

  async runScheduledAnalysis(name, fn) {
    this.#assertAnalysis(name);
    const loop = ANALYSES[name];
    const state = this[loop];
    if (!state.enabled || !this.analysis.get(name)) return Object.freeze({ status: 'DISABLED', name, loop });
    if (state.frozen) return Object.freeze({ status: 'FROZEN', name, loop });
    const result = await fn();
    this.#audit('ANALYSIS_EXECUTED', { name, loop });
    return Object.freeze({ status: 'EXECUTED', name, loop, result });
  }

  manualPolicyRollback({ fromVersion, toVersion, execute, reasonCode = 'MANUAL_POLICY_ROLLBACK' }) {
    const result = execute ? execute() : null;
    this.#audit('MANUAL_POLICY_ROLLBACK', { fromVersion, toVersion, reasonCode });
    return result;
  }

  manualSkillRollback({ registry, skillId, reasonCode = 'MANUAL_SKILL_ROLLBACK' }) {
    const result = registry.transition(skillId, SkillStatus.ROLLED_BACK, { manual: true, reasonCode });
    this.#audit('MANUAL_SKILL_ROLLBACK', { skillIdHash: sha256(String(skillId)).slice(0, 16), reasonCode });
    return result;
  }

  auditLog() { return [...this.audit].sort((a, b) => a.auditId.localeCompare(b.auditId)); }

  #assertAnalysis(name) { if (!(name in ANALYSES)) throw new Error(`UNKNOWN_ANALYSIS:${name}`); }
  #audit(action, details = {}) {
    const body = { action, details };
    const auditId = `audit-${sha256(canonicalJson(body)).slice(0, 24)}`;
    const entry = freeze({ auditId, ...body });
    if (!this.audit.some((item) => item.auditId === auditId)) this.audit.push(entry);
    return entry;
  }
}

export const EVOLUTION_ANALYSIS_LOOPS = ANALYSES;
